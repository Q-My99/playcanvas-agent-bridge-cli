import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const root = await mkdtemp(join(tmpdir(), 'pcbridge-processing-test-'));
process.env.PCBRIDGE_CONFIG_DIR = join(root, 'config');
const { ProcessingManager } = await import('../dist/processing/manager.js');
const { TOOLS_ROOT, verifyTools } = await import('../dist/processing/tools.js');
const bytes = Buffer.from('bounded-source');
const hash = value => createHash('sha256').update(value).digest('hex');
const target = { id: 'tab:1', kind: 'editor', platform: 'selfhost', processingProtocolVersion: 1, clientId: 'client-a', branchId: 'branch-a' };

test('processing requires opt-in, verifies tools, fences targets and enforces sequential bounded chunks', async () => {
    const project = join(root, 'project'); await mkdir(project, { recursive: true });
    const manager = new ProcessingManager(() => project);
    try {
        assert.equal((await manager.capabilities()).reason, 'LOCAL_DISABLED');
        await assert.rejects(manager.request({ ...target, processingProtocolVersion: 0 }, 'capabilities', {}), /PROCESSING_EDITOR_UNSUPPORTED/);
        await assert.rejects(manager.request({ ...target, platform: 'official' }, 'capabilities', {}), /SELFHOST_EDITOR_REQUIRED/);
        const dir = join(TOOLS_ROOT, 'test');
        const files = ['runner/convert.js', 'schema/catalog.json', 'bin/model', 'bin/texture'];
        const specs = [];
        for (const path of files) {
            const file = join(dir, path); await mkdir(join(file, '..'), { recursive: true });
            await writeFile(file, bytes); specs.push({ path, size: bytes.length, sha256: hash(bytes) });
        }
        await writeFile(join(dir, 'release.json'), JSON.stringify({ schemaVersion: 1, platform: process.platform, arch: process.arch,
            recipeVersion: 'asset-tools-v7', targetEngine: '1.77.0', release: 'test', formats: { texture: ['dxt'], model: ['glb'] },
            runner: specs[0], catalog: specs[1], binaries: { modelConverter: specs[2], textureConverter: specs[3] } }));
        await writeFile(join(TOOLS_ROOT, 'settings.json'), '{"enabled":true}');
        await writeFile(join(TOOLS_ROOT, 'active.json'), JSON.stringify({ directory: dir }));
        assert.equal((await manager.capabilities()).available, true);
        const begin = { jobId: 'job-a', kind: 'model', source: { filename: 'source.glb', size: bytes.length, hash: createHash('md5').update(bytes).digest('hex') } };
        await assert.rejects(manager.request(target, 'begin', { ...begin, source: { ...begin.source, filename: '../escape' } }), /INVALID_PROCESSING_TASK/);
        const { transferId } = await manager.request(target, 'begin', begin);
        const chunk = { transferId, offset: 0, data: bytes.toString('base64') };
        await assert.rejects(manager.request({ ...target, id: 'tab:2' }, 'chunk', chunk), /TARGET_MISMATCH/);
        await assert.rejects(manager.request({ ...target, clientId: 'new-page' }, 'status', { transferId }), /TARGET_MISMATCH/);
        await assert.rejects(manager.request({ ...target, branchId: 'branch-b' }, 'status', { transferId }), /TARGET_MISMATCH/);
        await assert.rejects(manager.request(target, 'chunk', { ...chunk, offset: 1 }), /INVALID_PROCESSING_CHUNK/);
        assert.equal((await manager.request(target, 'chunk', chunk)).offset, bytes.length);
        assert.equal((await manager.request(target, 'chunk', chunk)).offset, bytes.length, 'same chunk retry is idempotent');
        await assert.rejects(manager.request(target, 'chunk', { ...chunk, data: Buffer.alloc(bytes.length).toString('base64') }), /CHUNK_CONFLICT/);
        assert.equal((await manager.capabilities()).busy, true);
        await manager.request(target, 'cancel', { transferId });
        await assert.rejects(manager.request(target, 'status', { transferId }), /TARGET_MISMATCH/);
        await writeFile(join(dir, specs[0].path), Buffer.alloc(bytes.length));
        await assert.rejects(verifyTools(dir), /INTEGRITY_MISMATCH/);
        assert.equal((await manager.capabilities()).reason, 'TOOLS_UNAVAILABLE');
    } finally { await manager.close(); await rm(root, { recursive: true, force: true }); }
});
