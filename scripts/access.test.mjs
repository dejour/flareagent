import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { verifyAccessToken, accessIssuer } from '../lib/access.ts';
const keys=await generateKeyPair('RS256'),other=await generateKeyPair('RS256');
const config={teamDomain:'example.cloudflareaccess.com',audience:'cloudagent-aud'};
const issuer=accessIssuer(config);
async function token(overrides={},key=keys.privateKey){return new SignJWT({email:'owner@example.test',sub:'user-123',iss:issuer,aud:config.audience,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+300,...overrides}).setProtectedHeader({alg:'RS256'}).sign(key);}
const verify=t=>verifyAccessToken(t,config,async()=>keys.publicKey);
test('valid signed identity is scoped to Access team',async()=>{assert.equal((await verify(await token())).userId,'example.cloudflareaccess.com:user-123');});
test('expired identity rejected',async()=>{assert.equal(await verify(await token({exp:1})),null);});
test('wrong audience rejected',async()=>{assert.equal(await verify(await token({aud:'another-app'})),null);});
test('wrong issuer rejected',async()=>{assert.equal(await verify(await token({iss:'https://attacker.example'})),null);});
test('wrong signing key rejected',async()=>{assert.equal(await verify(await token({},other.privateKey)),null);});
test('missing email rejected',async()=>{assert.equal(await verify(await token({email:undefined})),null);});
test('malformed token rejected',async()=>{assert.equal(await verify('not-a-token'),null);});
test('untrusted JWKS hosts cannot be configured',()=>{assert.throws(()=>accessIssuer({teamDomain:'localhost:3000',audience:'x'}));});
