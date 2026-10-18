// Oracle Thick 모드(11g): 저장된 연결에 Thick이 있으면 첫 Oracle 연결 전에 Thick 모드를 켜려고 한다.
// 이 PC에는 Oracle Client가 없으므로: Thick 연결은 'Oracle Client 19 이상' 안내로 실패하고, Thin 연결은 그대로 동작해야 한다.
// (Thick/Thin은 프로세스마다 한 번 정해지므로 파일을 따로 둔다)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { register as registerDb } from '../src/desktop/db/index';
import { setHost, testHost } from '../src/desktop/host';
import { call } from '../src/desktop/ipc';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-thick-'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-thick-root-'));
setHost(testHost(tmp));
registerDb();

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Oracle Thick 모드', () => {
  it('Oracle Client가 없으면 Thick 연결은 알아듣게 실패하고 Thin 연결은 계속 쓸 수 있다', async () => {
    const thick = await call('db.save', root, { id: '', env: 'prod', kind: 'oracle', name: 'old_prd', host: '127.0.0.1', port: 1, service: 'ORCL', sid: true, thick: true, user: 'scott', password: 'tiger' });
    assert.equal(thick.thick, true);
    assert.equal(thick.sid, true);
    // 처음 Oracle을 쓰는 것은 Thin 연결이지만, 저장된 Thick 연결 때문에 Thick 모드를 먼저 시도한다 → 실패해도 Thin으로 계속
    const thin = await call('db.test', root, { id: '', env: 'dev', kind: 'oracle', name: 'new_dev', host: '127.0.0.1', port: 1, service: 'ORCLPDB1', user: 'scott', password: 'tiger' });
    assert.equal(thin.ok, false);
    assert.match(thin.message, /연결을 받지 않습니다.*\(NJS-503\)/);
    const r = await call('db.test', root, thick.id);
    assert.equal(r.ok, false);
    assert.match(r.message, /Oracle Client 19 이상/);
    assert.equal((await call('db.list', root))[0].lastTest?.ok, false);
  });
});
