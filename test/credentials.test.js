'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const creds = require('../src/s3/credentials');

function fakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 's3x-home-'));
  fs.mkdirSync(path.join(home, '.aws', 'sso', 'cache'), { recursive: true });
  fs.writeFileSync(path.join(home, '.aws', 'config'), [
    '[default]', 'region = us-east-1', '',
    '[profile dev]', 'region = eu-west-1', '',
    '[profile minio-test]', 'region = us-east-1', 'endpoint_url = http://127.0.0.1:19000', '',
    '[profile proc]', 'credential_process = echo \'{"Version":1,"AccessKeyId":"AKPROC","SecretAccessKey":"sp","SessionToken":"tp","Expiration":"2099-01-01T00:00:00Z"}\'', '',
    '[profile sso-new]', 'sso_session = corp', 'sso_account_id = 111122223333', 'sso_role_name = ReadOnly', 'region = us-west-2', '',
    '[sso-session corp]', 'sso_region = us-east-1', 'sso_start_url = https://corp.awsapps.com/start', '',
    '[profile role]', 'role_arn = arn:aws:iam::123456789012:role/Dev', 'source_profile = dev', 'region = eu-west-1', '',
    '[profile svc]', 'services = local', '',
    '[services local]', 's3 =', '  endpoint_url = http://localhost:9000', '',
  ].join('\n'));
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), ['[default]', 'aws_access_key_id = AKDEFAULT', 'aws_secret_access_key = sdefault', '', '[dev]', 'aws_access_key_id = AKDEV', 'aws_secret_access_key = sdev', '', '[minio-test]', 'aws_access_key_id = s3xtestkey', 'aws_secret_access_key = s3xtestsecret123', '', '[svc]', 'aws_access_key_id = a', 'aws_secret_access_key = b'].join('\n'));
  return home;
}

test('profiles are listed by name, default last', (t) => {
  const home = fakeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home };
  assert.deepStrictEqual(creds.listProfiles(env), ['dev', 'minio-test', 'proc', 'role', 'sso-new', 'svc', 'default']);
});

test('keys, endpoint_url and services sections', async (t) => {
  const home = fakeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home };
  assert.deepStrictEqual(await creds.resolveProfile('dev', { env }), { accessKeyId: 'AKDEV', secretAccessKey: 'sdev', sessionToken: undefined });
  assert.deepStrictEqual(creds.profileRegion('minio-test', env), { region: 'us-east-1', endpoint: 'http://127.0.0.1:19000', kind: 'keys' });
  assert.strictEqual(creds.profileRegion('svc', env).endpoint, 'http://localhost:9000');
  await assert.rejects(creds.resolveProfile('nope', { env }), (e) => e.code === 'NoProfile');
});

test('credential_process', async (t) => {
  const home = fakeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const c = await creds.resolveProfile('proc', { env: { HOME: home } });
  assert.strictEqual(c.accessKeyId, 'AKPROC');
  assert.strictEqual(c.sessionToken, 'tp');
});

test('SSO reuses the AWS CLI token; an expired token asks for aws sso login', async (t) => {
  const home = fakeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const env = { HOME: home };
  await assert.rejects(creds.resolveProfile('sso-new', { env }), (e) => e.code === 'SsoLogin' && e.loginCommand === 'aws sso login --profile sso-new');
  const file = path.join(home, '.aws', 'sso', 'cache', crypto.createHash('sha1').update('corp').digest('hex') + '.json');
  fs.writeFileSync(file, JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() + 3600e3).toISOString() }));
  let called;
  const c = await creds.resolveProfile('sso-new', { env, httpsJson: async (url, headers) => { called = { url, headers }; return { status: 200, body: { roleCredentials: { accessKeyId: 'ASIA', secretAccessKey: 's', sessionToken: 't', expiration: Date.now() + 3600e3 } } }; } });
  assert.strictEqual(c.accessKeyId, 'ASIA');
  assert.strictEqual(called.url, 'https://portal.sso.us-east-1.amazonaws.com/federation/credentials?account_id=111122223333&role_name=ReadOnly');
  assert.strictEqual(called.headers['x-amz-sso_bearer_token'], 'tok');
  fs.writeFileSync(file, JSON.stringify({ accessToken: 'tok', expiresAt: new Date(Date.now() - 1000).toISOString() }));
  await assert.rejects(creds.resolveProfile('sso-new', { env, httpsJson: async () => { throw new Error('must not call'); } }), (e) => e.code === 'SsoLogin');
});

test('assume role signs an STS request with the source profile', async (t) => {
  const home = fakeHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  let req;
  const c = await creds.resolveProfile('role', { env: { HOME: home }, httpsPost: async (url, headers, body) => { req = { url, headers, body }; return { status: 200, text: '<AssumeRoleResponse><AssumeRoleResult><Credentials><AccessKeyId>ASIAROLE</AccessKeyId><SecretAccessKey>rs</SecretAccessKey><SessionToken>rt</SessionToken><Expiration>2099-01-01T00:00:00Z</Expiration></Credentials></AssumeRoleResult></AssumeRoleResponse>' }; } });
  assert.strictEqual(c.accessKeyId, 'ASIAROLE');
  assert.strictEqual(req.url, 'https://sts.eu-west-1.amazonaws.com/');
  assert.match(req.headers.authorization, /Credential=AKDEV\/\d{8}\/eu-west-1\/sts\/aws4_request/);
  assert.match(req.body, /Action=AssumeRole/);
  assert.match(req.body, /RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2FDev/);
});

test('environment credentials only when asked', () => {
  assert.throws(() => creds.envCredentials({}), (e) => e.code === 'NoEnv');
  assert.deepStrictEqual(creds.envCredentials({ AWS_ACCESS_KEY_ID: 'a', AWS_SECRET_ACCESS_KEY: 'b' }), { accessKeyId: 'a', secretAccessKey: 'b', sessionToken: undefined });
});

test('INI parser: comments, nested values', () => {
  const p = creds.parseIni('# c\n[a]\nk = v ; note\n[services x]\ns3 =\n  endpoint_url = http://e\n');
  assert.strictEqual(p.a.k, 'v');
  assert.strictEqual(p['services x']['s3.endpoint_url'], 'http://e');
});
