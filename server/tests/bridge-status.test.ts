import { describe, it, expect, afterEach, jest } from '@jest/globals';
import fs from 'node:fs';
import { getEventListeners } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { LockHeldError } from '../src/instance-lock.js';
import { Bridge } from '../src/bridge.js';
import { BrokerClient, BrokerServer } from '../src/broker.js';
import { Dispatcher } from '../src/dispatcher.js';
import { createMcpServer } from '../src/create-server.js';
import { createOwnerStatusReader, bridgeStatus, parseOwnerReply, statusResponse, OWNER_STATUS_TIMEOUT_MS } from '../src/bridge-status.js';

const connection = { requestConnected: true, responseConnected: true, generation: 1 };
const plugin = (active = 0) => ({
  activeOperations: { kind: 'available', value: active },
  pluginVersion: { kind: 'available', value: '0.20.0.0' },
  lightroomVersion: { kind: 'available', value: '15.6.0.0' },
  catalogPath: { kind: 'available', value: '/fixture/catalog.lrcat' },
  registeredActions: { kind: 'available', value: ['get_bridge_status', 'ping'] },
});

afterEach(() => { jest.useRealTimers(); });

describe('owner status evidence', () => {
  it.each([0, 2])('reports fresh metadata and %i active operations', async active => {
    const call = jest.fn<Dispatcher['call']>().mockResolvedValue({ id: 'x', result: plugin(active) });
    const result = await createOwnerStatusReader({ dispatcher: { call }, connection: () => connection })();
    expect(result.health).toBe(active ? 'busy' : 'responsive');
    expect(result.pluginVersion).toEqual(plugin().pluginVersion);
    expect(result.version).not.toBe('0.20.0.0');
    expect(result.probe).toEqual(expect.objectContaining({ outcome: 'reply', startedAt: expect.any(String), finishedAt: expect.any(String) }));
    expect(call).toHaveBeenCalledWith('get_bridge_status', {}, OWNER_STATUS_TIMEOUT_MS);
  });

  it('returns disconnected without sending when either socket is down', async () => {
    const call = jest.fn<Dispatcher['call']>();
    for (const channel of ['requestConnected', 'responseConnected']) {
      const read = createOwnerStatusReader({ dispatcher: { call }, connection: () => ({ ...connection, [channel]: false }) });
      expect(await read()).toEqual(expect.objectContaining({ health: 'disconnected', catalogPath: { kind: 'unavailable', reason: 'not_observed' } }));
    }
    expect(call).not.toHaveBeenCalled();
  });

  it('ignores malformed transport frames without crashing or consuming the status reply', async () => {
    let dispatcher: Dispatcher;
    dispatcher = new Dispatcher({ getToken: () => 'fixture', log: () => {}, send: line => {
      const request = JSON.parse(line) as { id: string };
      queueMicrotask(() => {
        for (const frame of ['null', '[]', 'true', '42', '"bad"']) dispatcher.handleResponseLine(frame);
        dispatcher.handleResponseLine(JSON.stringify({ id: request.id, result: plugin() }));
      });
      return true;
    } });
    const result = await createOwnerStatusReader({ dispatcher, connection: () => connection })();
    expect(result.health).toBe('responsive');
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it('bounds a connected silent plugin and removes its dispatcher pending entry', async () => {
    jest.useFakeTimers();
    const dispatcher = new Dispatcher({ send: () => true, getToken: () => 'fixture', log: () => {} });
    const pending = createOwnerStatusReader({ dispatcher, connection: () => connection })();
    expect(dispatcher.pendingCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1500);
    expect(await pending).toEqual(expect.objectContaining({ health: 'unresponsive', probe: expect.objectContaining({ outcome: 'timeout' }) }));
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it.each([undefined, null, [], { ...plugin(), activeOperations: { kind: 'available', value: -1 } }])('rejects malformed plugin status %p', async result => {
    const read = createOwnerStatusReader({ dispatcher: { call: async () => ({ id: 'x', result }) }, connection: () => connection });
    expect(await read()).toEqual(expect.objectContaining({ health: 'unknown', probe: expect.objectContaining({ outcome: 'invalid' }) }));
  });

  it('recognizes an old plugin reply without inventing runtime metadata', async () => {
    const read = createOwnerStatusReader({ dispatcher: { call: async () => ({ id: 'x', error: 'Unknown action: get_bridge_status' }) }, connection: () => connection });
    expect(await read()).toEqual(expect.objectContaining({ health: 'responsive', probe: expect.objectContaining({ outcome: 'unsupported' }),
      pluginVersion: { kind: 'unavailable', reason: 'not_observed' } }));
  });

  it('does not call a local send failure an unresponsive plugin', async () => {
    const read = createOwnerStatusReader({ dispatcher: { call: async () => { throw new Error('token unavailable'); } }, connection: () => connection });
    expect(await read()).toEqual(expect.objectContaining({ health: 'unknown', probe: expect.objectContaining({ outcome: 'failed' }) }));
  });

  it('handles a real dispatcher token read failure without a false timeout', async () => {
    const dispatcher = new Dispatcher({ send: () => true, getToken: () => { throw new Error('missing token'); } });
    const result = await createOwnerStatusReader({ dispatcher, connection: () => connection })();
    expect(result.health).toBe('unknown');
    expect(result.probe.outcome).toBe('failed');
    expect(dispatcher.pendingCount()).toBe(0);
  });

  it('discards metadata after a response-only disconnect and reconnect', async () => {
    let current = connection;
    const read = createOwnerStatusReader({ dispatcher: { call: async () => {
      current = { ...connection, generation: 3 };
      return { id: 'x', result: plugin() };
    } }, connection: () => current });
    expect(await read()).toEqual(expect.objectContaining({ health: 'unknown', catalogPath: { kind: 'unavailable', reason: 'connection_changed' } }));
  });

  it.each([undefined, {}, { content: [] }, { content: [{ type: 'text', text: '{}' }] },
    { content: [{ type: 'text', text: '{"owner":{"kind":"available","value":{}}}' }] }])('rejects malformed owner response %p', response => {
    expect(parseOwnerReply(response)).toEqual({ kind: 'unavailable', reason: 'invalid_owner_reply' });
  });
});

describe('status through MCP', () => {
  it.each(['disconnected', 'responsive', 'busy', 'unresponsive'])('reports %s through the leader tool path', async health => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 'ipc.sock');
    let dispatcher: Dispatcher;
    dispatcher = new Dispatcher({ getToken: () => 'fixture', log: () => {}, send: line => {
      if (health === 'unresponsive') return true;
      const request = JSON.parse(line) as { id: string };
      queueMicrotask(() => dispatcher.handleResponseLine(JSON.stringify({ id: request.id, result: plugin(health === 'busy' ? 1 : 0) })));
      return true;
    } });
    const bridge = new Bridge({ ipcPath: endpoint, acquireLock: () => ({ release: () => {}, onLost: () => {} }),
      startLeader: () => ({
        readStatus: createOwnerStatusReader({ dispatcher, connection: () => ({ ...connection, responseConnected: health !== 'disconnected' }) }),
        callTool: () => new Promise(() => {}), stop: () => {},
      }), readToken: () => 'fixture', log: () => {},
    });
    await bridge.start();
    const server = createMcpServer({ callTool: (name, args, options) => bridge.callTool(name, args, options) });
    const client = new Client({ name: 'status-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      const result = await client.callTool({ name: 'get_bridge_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      const owner = parseOwnerReply(result);
      expect(owner.kind).toBe('available');
      if (owner.kind === 'available') expect(owner.value.health).toBe(health);
      expect(dispatcher.pendingCount()).toBe(0);
    } finally {
      await client.close(); await server.close(); bridge.stop(); fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns useful no-owner status without starting election and validates empty args', async () => {
    const acquireLock = jest.fn(() => { throw new Error('must not elect'); });
    const bridge = new Bridge({ ipcPath: 'unused', acquireLock, startLeader: () => { throw new Error('unused'); }, readToken: () => null });
    const server = createMcpServer({ callTool: (name, args, options) => bridge.callTool(name, args, options) }, { readOnly: true, toolsets: ['core'] });
    const client = new Client({ name: 'status-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    await client.connect(a);
    try {
      expect((await client.listTools()).tools.map(tool => tool.name)).toContain('get_bridge_status');
      const result = await client.callTool({ name: 'get_bridge_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.content).toEqual([expect.objectContaining({ type: 'text', text: expect.stringContaining('"health":"unknown"') })]);
      expect(acquireLock).not.toHaveBeenCalled();
      expect((await client.callTool({ name: 'get_bridge_status', arguments: { timeout: 1 } })).isError).toBe(true);
    } finally { await client.close(); await server.close(); bridge.stop(); }
  });

  it('bypasses an unresolved readiness wait in the direct server fixture path', async () => {
    const call = jest.fn<Dispatcher['call']>();
    const server = createMcpServer({ dispatcher: { call }, isReady: () => false,
      settleReadiness: () => new Promise(() => {}),
    });
    const client = new Client({ name: 'status-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      expect((await client.callTool({ name: 'get_bridge_status', arguments: {} })).isError).not.toBe(true);
      expect(call).not.toHaveBeenCalled();
    } finally { await client.close(); await server.close(); }
  });
});

describe('bounded owner forwarding', () => {
  it('serves status through leader and follower while ordinary calls are blocked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 'ipc.sock');
    const readStatus = createOwnerStatusReader({ dispatcher: { call: async () => ({ id: 'x', result: plugin(1) }) }, connection: () => connection });
    const leader = new Bridge({ ipcPath: endpoint, acquireLock: () => ({ release: () => {}, onLost: () => {} }),
      startLeader: () => ({ readStatus, callTool: () => new Promise(() => {}), stop: () => {} }),
      readToken: () => 'fixture', log: () => {},
    });
    const follower = new Bridge({ ipcPath: endpoint, acquireLock: () => { throw new LockHeldError(1, 1, 2); },
      startLeader: () => { throw new Error('must not lead'); }, readToken: () => 'fixture', log: () => {},
    });
    await leader.start(); await follower.start();
    const server = createMcpServer({ callTool: (name, args, options) => follower.callTool(name, args, options) });
    const client = new Client({ name: 'status-test', version: '1' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      const local = parseOwnerReply(await leader.callTool('get_bridge_status', {}));
      expect(local.kind).toBe('available');
      const result = await client.callTool({ name: 'get_bridge_status', arguments: {} });
      expect(result.isError).not.toBe(true);
      const owner = parseOwnerReply(result);
      expect(owner.kind).toBe('available');
      if (owner.kind === 'available') expect(owner.value.health).toBe('busy');
      expect(result.content).toEqual([expect.objectContaining({ text: expect.stringContaining('"role":"follower"') })]);
    } finally {
      await client.close(); await server.close(); follower.stop(); leader.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps local and owner versions distinct for an older owner', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 'ipc.sock');
    const read = createOwnerStatusReader({ dispatcher: { call: async () => ({ id: 'x', result: plugin() }) }, connection: () => connection });
    const oldOwner = { ...await read(), version: '0.1.0' };
    const broker = new BrokerServer({ path: endpoint, readToken: () => 'fixture',
      callTool: async () => statusResponse(bridgeStatus('leader', { kind: 'available', value: oldOwner })),
    });
    const follower = new Bridge({ ipcPath: endpoint, acquireLock: () => { throw new LockHeldError(1, 1, 2); },
      startLeader: () => { throw new Error('must not lead'); }, readToken: () => 'fixture', log: () => {},
    });
    await broker.listen(); await follower.start();
    try {
      const result = await follower.callTool('get_bridge_status', {});
      expect(result.content[0].text).toContain('"version":"0.1.0"');
      expect(result.content[0].text).toContain('"role":"follower"');
      expect(parseOwnerReply(result)).toEqual({ kind: 'available', value: oldOwner });
    } finally { follower.stop(); broker.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('cancels only status and removes its local pending entry', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 'ipc.sock');
    const server = new BrokerServer({ path: endpoint, readToken: () => 'fixture', callTool: () => new Promise(() => {}) });
    const client = new BrokerClient({ path: endpoint, readToken: () => 'fixture' });
    await server.listen(); await client.connect();
    try {
      const controller = new AbortController();
      const result = client.callTool('get_bridge_status', {}, { signal: controller.signal });
      controller.abort();
      expect((await result).isError).toBe(true);
      expect(client.pendingCount()).toBe(0);
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    } finally { client.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('expires only status, ignores its late reply and preserves an ordinary call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'status-'));
    const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\${path.basename(dir)}` : path.join(dir, 'ipc.sock');
    let replyStatus: (value: ReturnType<typeof statusResponse>) => void = () => {};
    const server = new BrokerServer({ path: endpoint, readToken: () => 'fixture', log: () => {},
      callTool: name => name === 'get_bridge_status'
        ? new Promise(resolve => { replyStatus = resolve; })
        : new Promise(resolve => setTimeout(() => resolve({ content: [{ type: 'text', text: 'ordinary finished' }] }), 2200)),
    });
    const client = new BrokerClient({ path: endpoint, readToken: () => 'fixture' });
    await server.listen(); await client.connect();
    try {
      const ordinary = client.callTool('search_photos', {});
      expect(parseOwnerReply(await client.callTool('get_bridge_status', {}))).toEqual({ kind: 'unavailable', reason: 'owner_timeout' });
      expect(client.pendingCount()).toBe(1);
      replyStatus(statusResponse(bridgeStatus('none', { kind: 'unavailable', reason: 'old' })));
      expect((await ordinary).content[0].text).toBe('ordinary finished');
      expect(client.pendingCount()).toBe(0);
    } finally { client.close(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
