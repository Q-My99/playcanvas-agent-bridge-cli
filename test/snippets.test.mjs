import assert from "node:assert/strict";
import test from "node:test";
import {
  scriptParseSnippet,
  scriptSetTextSnippet,
  templateApplySnippet,
  templateOverridesSnippet,
} from "../dist/snippets.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function runSnippet(source, bindings) {
  const names = Object.keys(bindings);
  return new AsyncFunction(...names, source)(...names.map((name) => bindings[name]));
}

function passthroughSerialize(value) {
  return value === undefined ? "[undefined]" : structuredClone(value);
}

function templateFixture({
  applyAccepted = true,
  invalidOverrideId = null,
  callbackDelayMs = 25,
  overrideDelayMs = 5,
  callbackEnabled = true,
} = {}) {
  const overrideCounts = new Map([["one", 2], ["two", 1]]);
  const entities = new Map();
  const templateAssets = new Map();
  let activeApply = null;
  let concurrent = false;
  const applied = [];

  for (const [index, id] of ["one", "two"].entries()) {
    const templateId = index + 100;
    const assetValues = {
      id: templateId,
      name: `Template ${id}`,
      type: "template",
      "data.entities": { root: { parent: null, enabled: true } },
    };
    templateAssets.set(templateId, { get: (path) => assetValues[path] });
    const values = {
      resource_id: id,
      template_id: templateId,
      enabled: true,
    };
    entities.set(id, { get: (path) => values[path] });
  }

  const editor = {
    api: {
      globals: {
        entities: { get: (id) => entities.get(String(id)) },
        assets: { get: (id) => templateAssets.get(Number(id)) },
      },
    },
    call(method, entity, callback) {
      if (method === "permissions:write") return true;
      const id = entity.get("resource_id");
      if (method === "templates:computeFilteredOverrides") {
        if (id === invalidOverrideId) return { unexpected: true };
        const conflicts = Array.from(
          { length: overrideCounts.get(id) || 0 },
          () => ({ path: "name" }),
        );
        return {
          conflicts,
          addedEntities: [],
          deletedEntities: [],
          totalOverrides: conflicts.length,
        };
      }
      if (method === "templates:apply") {
        if (!applyAccepted) return false;
        if (activeApply) concurrent = true;
        activeApply = id;
        applied.push(id);
        setTimeout(() => {
          overrideCounts.set(id, 0);
        }, overrideDelayMs);
        if (callbackEnabled) {
          setTimeout(() => {
            activeApply = null;
            callback(undefined);
          }, callbackDelayMs);
        }
        return true;
      }
      throw new Error(`unexpected Editor call ${method}`);
    },
  };

  return {
    applied,
    concurrent: () => concurrent,
    editor,
    setOverrideCount: (id, count) => overrideCounts.set(id, count),
  };
}

test("template apply-many validates then applies serially until overrides are stably zero", async () => {
  const fixture = templateFixture();
  const result = await runSnippet(templateApplySnippet(), {
    editor: fixture.editor,
    command: {
      timeoutMs: 2000,
      args: { entityIds: ["one", "two"], pollIntervalMs: 5, waitTimeoutMs: 2000 },
    },
    serialize: passthroughSerialize,
  });
  assert.deepEqual(fixture.applied, ["one", "two"]);
  assert.equal(fixture.concurrent(), false);
  assert.equal(result.affected, 2);
  assert.equal(result.verified, true);
  assert.equal(result.verificationScope, "current-editor-observer");
  assert.equal(result.reloadPersistenceChecked, false);
  assert.ok(result.items.every((item) => item.completionSignal === "pipeline-callback-and-overrides"));
  assert.deepEqual(result.items.map((item) => [item.before, item.after]), [[2, 0], [1, 0]]);
});

test("template overrides reads the Template asset without mutating it", async () => {
  const fixture = templateFixture();
  const result = await runSnippet(templateOverridesSnippet(), {
    editor: fixture.editor,
    command: { args: { entityId: "one" } },
    serialize: passthroughSerialize,
  });
  assert.equal(result.count, 2);
  assert.equal(result.templateId, 100);
  assert.deepEqual(fixture.applied, []);
});

test("template apply reports an explicit no-op without scheduling a pipeline job", async () => {
  const fixture = templateFixture();
  fixture.setOverrideCount("one", 0);
  const result = await runSnippet(templateApplySnippet(), {
    editor: fixture.editor,
    command: {
      timeoutMs: 2000,
      args: { entityId: "one", pollIntervalMs: 5, waitTimeoutMs: 2000 },
    },
    serialize: passthroughSerialize,
  });
  assert.deepEqual(fixture.applied, []);
  assert.equal(result.items[0].completionSignal, "no-overrides");
  assert.equal(result.items[0].accepted, null);
  assert.equal(result.items[0].callbackReceived, false);
});

test("template apply fails immediately when the Editor rejects the pipeline job", async () => {
  const fixture = templateFixture({ applyAccepted: false });
  await assert.rejects(
    runSnippet(templateApplySnippet(), {
      editor: fixture.editor,
      command: {
        timeoutMs: 2000,
        args: { entityId: "one", pollIntervalMs: 5, waitTimeoutMs: 2000 },
      },
      serialize: passthroughSerialize,
    }),
    (error) => {
      assert.equal(error.code, "TEMPLATE_APPLY_REJECTED");
      assert.deepEqual(error.details.completedEntityIds, []);
      return true;
    },
  );
});

test("template apply-many validates every override shape before its first write", async () => {
  const fixture = templateFixture({ invalidOverrideId: "two" });
  await assert.rejects(
    runSnippet(templateApplySnippet(), {
      editor: fixture.editor,
      command: {
        timeoutMs: 2000,
        args: { entityIds: ["one", "two"], pollIntervalMs: 5, waitTimeoutMs: 2000 },
      },
      serialize: passthroughSerialize,
    }),
    (error) => error.code === "TEMPLATE_OVERRIDES_UNREADABLE",
  );
  assert.deepEqual(fixture.applied, []);
});

test("template apply waits for observer convergence after an early callback", async () => {
  const fixture = templateFixture({ callbackDelayMs: 5, overrideDelayMs: 80 });
  const result = await runSnippet(templateApplySnippet(), {
    editor: fixture.editor,
    command: {
      timeoutMs: 2000,
      args: { entityId: "one", pollIntervalMs: 10, waitTimeoutMs: 2000 },
    },
    serialize: passthroughSerialize,
  });
  assert.equal(result.items[0].observerVerified, true);
  assert.ok(result.items[0].durationMs >= 70);
});

test("template apply callback timeout reports unknown state", async () => {
  const fixture = templateFixture({ callbackEnabled: false });
  await assert.rejects(
    runSnippet(templateApplySnippet(), {
      editor: fixture.editor,
      command: {
        timeoutMs: 1000,
        args: { entityIds: ["one", "two"], pollIntervalMs: 10, waitTimeoutMs: 1000 },
      },
      serialize: passthroughSerialize,
    }),
    (error) => {
      assert.equal(error.code, "TEMPLATE_CALLBACK_TIMEOUT");
      assert.equal(error.details.stateUnknown, true);
      assert.deepEqual(error.details.completedEntityIds, []);
      return true;
    },
  );
  assert.deepEqual(fixture.applied, ["one"]);
});

test("script set-text wait verifies remote content and refreshes parse metadata", async () => {
  const expectedText = "class CityQuizController {}";
  const state = {
    file: null,
    scripts: { oldController: { attributesOrder: ["old"] } },
  };
  let parseCalls = 0;
  const values = {
    id: 300991959,
    name: "New Asset~300991959",
    type: "script",
    path: [],
    tags: [],
  };
  const asset = {
    observer: {},
    get(path) {
      if (path === "file") return state.file;
      if (path === "file.filename") return state.file && state.file.filename;
      if (path === "file.hash") return state.file && state.file.hash;
      if (path === "file.size") return state.file && state.file.size;
      if (path === "data.scripts") return state.scripts;
      return values[path];
    },
  };
  const parsedScripts = {
    cityQuizController: {
      attributesOrder: ["questions"],
    },
  };
  const workerScripts = {
    cityQuizController: {
      attributesOrder: ["questions"],
      attributes: {},
      attributesInvalid: [],
      name: "cityQuizController",
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call(method, _observer, callback) {
      assert.equal(method, "scripts:parse");
      parseCalls += 1;
      state.scripts = parsedScripts;
      callback(null, { scripts: workerScripts, warnings: [] });
    },
  };
  const fetch = async (url, options = {}) => {
    if (options.method === "PUT") {
      setTimeout(() => {
        state.file = { filename: "cityQuizController.js", hash: "new", size: expectedText.length };
      }, 10);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    assert.match(String(url), /\/file\/cityQuizController\.js\?/);
    return { ok: true, text: async () => expectedText };
  };

  const result = await runSnippet(scriptSetTextSnippet(), {
    editor,
    command: {
      timeoutMs: 2000,
      args: {
        assetId: "300991959",
        filename: "cityQuizController.js",
        text: expectedText,
        parse: true,
        wait: true,
        pollIntervalMs: 5,
        waitTimeoutMs: 2000,
      },
    },
    window: { config: {} },
    fetch,
    FormData,
    Blob,
    URLSearchParams,
  });
  assert.equal(result.waited, true);
  assert.equal(result.parsed, true);
  assert.equal(result.file.hash, "new");
  assert.equal(result.file.remoteContentVerified, true);
  assert.equal(parseCalls, 1);
  assert.deepEqual(result.scriptMetadata.cityQuizController.attributesOrder, ["questions"]);
});

test("script wait rejects the pre-PUT hash until the Editor observer advances", async () => {
  const expectedText = "const version = 2;";
  let remoteText = "const version = 1;";
  const state = {
    file: { filename: "controller.js", hash: "old", size: remoteText.length },
  };
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 9,
        name: "controller.js",
        type: "script",
        path: [],
        tags: [],
        "data.scripts": {},
      };
      if (path === "file") return state.file;
      if (path === "file.filename") return state.file.filename;
      if (path === "file.hash") return state.file.hash;
      if (path === "file.size") return state.file.size;
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
  };
  const fetch = async (_url, options = {}) => {
    if (options.method === "PUT") {
      remoteText = expectedText;
      setTimeout(() => {
        state.file = { filename: "controller.js", hash: "new", size: expectedText.length };
      }, 130);
      return { ok: true, json: async () => ({ ok: true }) };
    }
    return { ok: true, text: async () => remoteText };
  };

  const result = await runSnippet(scriptSetTextSnippet(), {
    editor,
    command: {
      timeoutMs: 2000,
      args: {
        assetId: "9",
        filename: "controller.js",
        text: expectedText,
        parse: false,
        wait: true,
        pollIntervalMs: 25,
        waitTimeoutMs: 2000,
      },
    },
    window: { config: {} },
    fetch,
    FormData,
    Blob,
    URLSearchParams,
  });
  assert.equal(result.file.hash, "new");
  assert.ok(result.durationMs >= 120, `returned too early after ${result.durationMs}ms`);
});

test("script parse invalid fails immediately without requeueing parse", async () => {
  let parseCalls = 0;
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 7,
        name: "broken.js",
        type: "script",
        file: { filename: "broken.js", hash: "new", size: 8 },
        "file.filename": "broken.js",
        "file.hash": "new",
        "file.size": 8,
        "data.scripts": {},
        path: [],
        tags: [],
      };
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call(_method, _observer, callback) {
      parseCalls += 1;
      callback(null, {
        scripts: {},
        scriptsInvalid: [{ message: "Unexpected token" }],
      });
    },
  };
  const fetch = async (_url, options = {}) => options.method === "PUT"
    ? { ok: true, json: async () => ({ ok: true }) }
    : { ok: true, text: async () => "broken" };

  await assert.rejects(
    runSnippet(scriptSetTextSnippet(), {
      editor,
      command: {
        timeoutMs: 2000,
        args: {
          assetId: "7",
          filename: "broken.js",
          text: "broken",
          parse: true,
          wait: true,
          pollIntervalMs: 5,
          waitTimeoutMs: 2000,
        },
      },
      window: { config: {} },
      fetch,
      FormData,
      Blob,
      URLSearchParams,
    }),
    (error) => {
      assert.equal(error.code, "SCRIPT_PARSE_INVALID");
      assert.equal(error.details.scriptsInvalid.length, 1);
      return true;
    },
  );
  assert.equal(parseCalls, 1);
});

test("standalone script parse waits for current Editor metadata exactly once", async () => {
  let scripts = {};
  let parseCalls = 0;
  const parsedScripts = {
    controller: {
      attributesOrder: ["speed"],
      attributes: { speed: { type: "number", default: 1 } },
    },
  };
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 8,
        name: "controller.js",
        type: "script",
        file: { filename: "controller.js", hash: "hash", size: 10 },
        "file.filename": "controller.js",
        "file.hash": "hash",
        "file.size": 10,
        path: [],
        tags: [],
      };
      if (path === "data.scripts") return scripts;
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call(_method, _observer, callback) {
      parseCalls += 1;
      scripts = parsedScripts;
      callback(null, { scripts: parsedScripts, scriptsInvalid: [] });
    },
  };
  const result = await runSnippet(scriptParseSnippet(), {
    editor,
    command: { timeoutMs: 2000, args: { assetId: "8", pollIntervalMs: 5, waitTimeoutMs: 2000 } },
    window: { config: {} },
    fetch: async () => { throw new Error("unexpected fetch"); },
    FormData,
    Blob,
    URLSearchParams,
  });
  assert.equal(parseCalls, 1);
  assert.equal(result.observerVerified, true);
  assert.deepEqual(result.scriptMetadata.controller.attributesOrder, ["speed"]);
});

test("standalone parse treats attribute warnings as invalid without claiming a file update", async () => {
  let parseCalls = 0;
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 10,
        name: "warning.js",
        type: "script",
        file: { filename: "warning.js", hash: "hash", size: 10 },
        "file.filename": "warning.js",
        "file.hash": "hash",
        "file.size": 10,
        "data.scripts": {},
        path: [],
        tags: [],
      };
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call(_method, _observer, callback) {
      parseCalls += 1;
      callback(null, {
        scripts: {
          warning: {
            attributesOrder: [],
            attributesInvalid: [{ severity: 4, message: "warning" }],
          },
        },
        scriptsInvalid: [],
      });
    },
  };
  await assert.rejects(
    runSnippet(scriptParseSnippet(), {
      editor,
      command: { timeoutMs: 2000, args: { assetId: "10", waitTimeoutMs: 2000 } },
      window: { config: {} },
      fetch: async () => { throw new Error("unexpected fetch"); },
      FormData,
      Blob,
      URLSearchParams,
    }),
    (error) => {
      assert.equal(error.code, "SCRIPT_PARSE_INVALID");
      assert.equal(error.details.fileUpdated, false);
      assert.equal(error.details.attributesInvalid[0].errors[0].severity, 4);
      return true;
    },
  );
  assert.equal(parseCalls, 1);
});

test("script update reports no declarations as a terminal parse error", async () => {
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 11,
        name: "empty.js",
        type: "script",
        file: { filename: "empty.js", hash: "old", size: 0 },
        "file.filename": "empty.js",
        "file.hash": "old",
        "file.size": 0,
        "data.scripts": {},
        path: [],
        tags: [],
      };
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call(_method, _observer, callback) {
      callback(null, { scripts: {}, scriptsInvalid: [] });
    },
  };
  await assert.rejects(
    runSnippet(scriptSetTextSnippet(), {
      editor,
      command: {
        timeoutMs: 2000,
        args: {
          assetId: "11",
          filename: "empty.js",
          text: "",
          parse: true,
          wait: false,
          waitTimeoutMs: 2000,
        },
      },
      window: { config: {} },
      fetch: async () => ({ ok: true, json: async () => ({ ok: true }) }),
      FormData,
      Blob,
      URLSearchParams,
    }),
    (error) => {
      assert.equal(error.code, "SCRIPT_NO_DECLARATIONS");
      assert.equal(error.details.fileUpdated, true);
      return true;
    },
  );
});

test("standalone parse callback timeout beats the outer RPC deadline", async () => {
  const asset = {
    observer: {},
    get(path) {
      const values = {
        id: 12,
        name: "slow.js",
        type: "script",
        "data.scripts": {},
        path: [],
        tags: [],
      };
      return values[path];
    },
  };
  const editor = {
    api: { globals: { assets: { get: () => asset }, accessToken: null } },
    call() {},
  };
  const startedAt = Date.now();
  await assert.rejects(
    runSnippet(scriptParseSnippet(), {
      editor,
      command: { timeoutMs: 1000, args: { assetId: "12", waitTimeoutMs: 1000 } },
      window: { config: {} },
      fetch: async () => { throw new Error("unexpected fetch"); },
      FormData,
      Blob,
      URLSearchParams,
    }),
    (error) => error.code === "SCRIPT_PARSE_CALLBACK_TIMEOUT",
  );
  assert.ok(Date.now() - startedAt < 900);
});
