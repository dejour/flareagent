import { getWorkspaceUser } from './workspace-auth';
import { Workspace } from './workspace';
export const dynamic = 'force-dynamic';
export default async function Page() {
  const user = await getWorkspaceUser();
  return (
    <Workspace
      user={user ? { name: user.displayName, email: user.email } : null}
    />
  );
}
