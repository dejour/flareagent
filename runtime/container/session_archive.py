"""Save only a session's Git changes and Codex rollouts, never its base repo."""
import io
import json
import os
import re
import stat
import subprocess
import sys
import tempfile
import zipfile

REPO = os.environ.get('CLOUDAGENT_SESSION_REPO', '/workspace/repo')
CODEX = os.environ.get('CLOUDAGENT_SESSION_CODEX', '/workspace/.codex')
WORKSPACE = os.environ.get('CLOUDAGENT_SESSION_WORKSPACE', '/workspace')
LIMIT = 80 * 1024 * 1024
SHA = re.compile(r'^[0-9a-f]{40,64}$')
EMPTY_BASE = '0' * 40
CACHE_DIRS = {'.codex', 'node_modules', '__pycache__', '.next', 'dist', 'build', '.cache', '.venv'}


def git(*args, input=None):
    return subprocess.run(['git', '-C', REPO, *args], input=input,
                          stdout=subprocess.PIPE, check=True).stdout


def valid_path(name):
    parts = name.split('/')
    if not name or name.startswith('/') or any(p in ('', '.', '..') for p in parts):
        raise ValueError('Invalid checkpoint path')
    return name


def add_file(archive, name, data):
    global size
    size += len(data)
    if size > LIMIT:
        raise ValueError('Session changes exceed 80 MiB')
    archive.writestr(name, data)


def pack(base):
    if not SHA.fullmatch(base):
        raise ValueError('Invalid base commit')
    has_repo = base != EMPTY_BASE
    if has_repo:
        if not os.path.isdir(os.path.join(REPO, '.git')):
            raise ValueError('Recorded repository is missing')
        git('cat-file', '-e', base + '^{commit}')
    meta = {'base': base, 'head': None, 'branch': None, 'refs': {}, 'untracked': {}, 'workspace': {}}
    with zipfile.ZipFile(sys.stdout.buffer, 'w', zipfile.ZIP_DEFLATED) as archive:
        if has_repo:
            meta['head'] = git('rev-parse', 'HEAD').decode().strip()
            meta['branch'] = git('symbolic-ref', '-q', '--short', 'HEAD').decode().strip() if subprocess.run(
                ['git', '-C', REPO, 'symbolic-ref', '-q', '--short', 'HEAD'],
                stdout=subprocess.DEVNULL).returncode == 0 else None
            for line in git('for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads').decode().splitlines():
                name, oid = line.rsplit(' ', 1)
                meta['refs'][name] = oid
            if int(git('rev-list', '--count', '--branches', 'HEAD', '^' + base)):
                with tempfile.TemporaryDirectory() as temporary:
                    bundle = os.path.join(temporary, 'changes.bundle')
                    git('bundle', 'create', bundle, '--branches', 'HEAD', '^' + base)
                    with open(bundle, 'rb') as source:
                        add_file(archive, 'git/commits.bundle', source.read())
            add_file(archive, 'git/staged.patch', git('diff', '--cached', '--binary', 'HEAD'))
            add_file(archive, 'git/unstaged.patch', git('diff', '--binary'))
            for raw in git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0'):
                if not raw:
                    continue
                relative = valid_path(os.fsdecode(raw))
                filename = os.path.join(REPO, relative)
                mode = os.lstat(filename).st_mode
                if stat.S_ISLNK(mode):
                    meta['untracked'][relative] = {'kind': 'symlink', 'mode': mode & 0o777}
                    add_file(archive, 'untracked/' + relative, os.fsencode(os.readlink(filename)))
                elif stat.S_ISREG(mode):
                    meta['untracked'][relative] = {'kind': 'file', 'mode': mode & 0o777}
                    with open(filename, 'rb') as source:
                        add_file(archive, 'untracked/' + relative, source.read())
                else:
                    raise ValueError('Unsupported untracked file type')
        else:
            for parent, dirs, files in os.walk(WORKSPACE, followlinks=False):
                relative_parent = os.path.relpath(parent, WORKSPACE)
                files += [d for d in dirs if d not in CACHE_DIRS and os.path.islink(os.path.join(parent, d))]
                dirs[:] = [d for d in dirs if d not in CACHE_DIRS and not os.path.islink(os.path.join(parent, d))]
                for name in files:
                    if name in ('.cloudagent-session', '.cloudagent-bridge-error'):
                        continue
                    relative = valid_path(os.path.join(relative_parent, name) if relative_parent != '.' else name)
                    filename = os.path.join(parent, name)
                    mode = os.lstat(filename).st_mode
                    if stat.S_ISLNK(mode):
                        meta['workspace'][relative] = {'kind': 'symlink', 'mode': mode & 0o777}
                        add_file(archive, 'workspace/' + relative, os.fsencode(os.readlink(filename)))
                    elif stat.S_ISREG(mode):
                        meta['workspace'][relative] = {'kind': 'file', 'mode': mode & 0o777}
                        with open(filename, 'rb') as source:
                            add_file(archive, 'workspace/' + relative, source.read())
        for directory in ('sessions', 'archived_sessions'):
            root = os.path.join(CODEX, directory)
            for parent, dirs, files in os.walk(root, followlinks=False):
                dirs[:] = [d for d in dirs if not os.path.islink(os.path.join(parent, d))]
                for name in files:
                    filename = os.path.join(parent, name)
                    if not os.path.isfile(filename) or os.path.islink(filename):
                        continue
                    relative = valid_path(os.path.relpath(filename, CODEX))
                    with open(filename, 'rb') as source:
                        add_file(archive, 'codex/' + relative, source.read())
        add_file(archive, 'manifest.json', json.dumps(meta).encode())


def destination(root, relative):
    relative = valid_path(relative)
    target = os.path.join(root, relative)
    current = root
    for component in relative.split('/')[:-1]:
        current = os.path.join(current, component)
        if os.path.islink(current):
            raise ValueError('Checkpoint has a symlink parent')
    if os.path.lexists(target):
        raise ValueError('Checkpoint destination already exists')
    os.makedirs(os.path.dirname(target), exist_ok=True)
    return target


def restore(base):
    data = sys.stdin.buffer.read(LIMIT + 1)
    if len(data) > LIMIT or not SHA.fullmatch(base):
        raise ValueError('Invalid checkpoint')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        members = archive.infolist()
        if sum(member.file_size for member in members) > LIMIT:
            raise ValueError('Checkpoint expands beyond limit')
        if len({member.filename for member in members}) != len(members):
            raise ValueError('Duplicate checkpoint entry')
        for member in members:
            valid_path(member.filename)
            if member.is_dir() or member.filename.split('/')[0] not in ('git', 'codex', 'untracked', 'workspace') and member.filename != 'manifest.json':
                raise ValueError('Invalid checkpoint entry')
            if member.filename.startswith('codex/') and not member.filename.startswith(('codex/sessions/', 'codex/archived_sessions/')):
                raise ValueError('Credentials cannot be restored')
        meta = json.loads(archive.read('manifest.json'))
        if meta['base'] != base:
            raise ValueError('Checkpoint base does not match session')
        has_repo = meta['head'] is not None
        if has_repo:
            if not SHA.fullmatch(meta['head']) or git('rev-parse', 'HEAD').decode().strip() != base:
                raise ValueError('Repository is not at checkpoint base')
            if 'git/commits.bundle' in archive.namelist():
                with tempfile.TemporaryDirectory() as temporary:
                    bundle = os.path.join(temporary, 'changes.bundle')
                    with open(bundle, 'wb') as target:
                        target.write(archive.read('git/commits.bundle'))
                    for line in git('bundle', 'list-heads', bundle).decode().splitlines():
                        ref = line.split(' ', 1)[1]
                        git('fetch', '--no-tags', bundle, ref)
            git('checkout', '--detach', base)
            for name, oid in meta['refs'].items():
                git('check-ref-format', '--branch', name)
                if not SHA.fullmatch(oid):
                    raise ValueError('Invalid branch commit')
                git('update-ref', 'refs/heads/' + name, oid)
            branch = meta['branch']
            if branch:
                if branch not in meta['refs']:
                    raise ValueError('Checkpoint branch missing')
                git('switch', branch)
            else:
                git('checkout', '--detach', meta['head'])
            staged = archive.read('git/staged.patch')
            if staged:
                git('apply', '--index', '--binary', '-', input=staged)
            unstaged = archive.read('git/unstaged.patch')
            if unstaged:
                git('apply', '--binary', '-', input=unstaged)
            for relative, info in meta['untracked'].items():
                target = destination(REPO, relative)
                content = archive.read('untracked/' + relative)
                if info['kind'] == 'symlink':
                    os.symlink(os.fsdecode(content), target)
                elif info['kind'] == 'file':
                    with open(target, 'xb') as output:
                        output.write(content)
                    os.chmod(target, info['mode'] & 0o777)
                else:
                    raise ValueError('Invalid untracked file type')
        else:
            for relative, info in meta.get('workspace', {}).items():
                if relative.split('/')[0] in CACHE_DIRS or relative in ('.cloudagent-session', '.cloudagent-bridge-error'):
                    raise ValueError('Invalid workspace checkpoint path')
                target = destination(WORKSPACE, relative)
                content = archive.read('workspace/' + relative)
                if info['kind'] == 'symlink':
                    os.symlink(os.fsdecode(content), target)
                elif info['kind'] == 'file':
                    with open(target, 'xb') as output:
                        output.write(content)
                    os.chmod(target, info['mode'] & 0o777)
                else:
                    raise ValueError('Invalid workspace file type')
        for member in members:
            if member.filename.startswith('codex/'):
                target = destination(CODEX, member.filename[6:])
                with open(target, 'xb') as output:
                    output.write(archive.read(member))


size = 0
if sys.argv[1] == 'pack':
    pack(sys.argv[2])
elif sys.argv[1] == 'restore':
    restore(sys.argv[2])
else:
    raise ValueError('Unknown archive operation')
