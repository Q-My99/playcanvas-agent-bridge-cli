import assert from "node:assert/strict";
import http from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { BuilderManager } from "../dist/builder/manager.js";

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function waitForJob(builder, id) {
  for (let index = 0; index < 200; index += 1) {
    const job = builder.get(id);
    if (job?.state === "completed" || job?.state === "error") return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for build job.");
}

test("Template builder uses project env precedence and uploads files directly through S3", async (t) => {
  const tmpBase = join(process.cwd(), "tmp");
  await mkdir(tmpBase, { recursive: true });
  const root = await mkdtemp(join(tmpBase, "builder-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectDirectory = join(root, "1-Builder");
  const tmpDirectory = join(projectDirectory, "tmp");
  const assetDirectory = join(projectDirectory, "assets");
  await mkdir(assetDirectory, { recursive: true });
  const texturePath = join(assetDirectory, "texture.png");
  const scriptPath = join(assetDirectory, "mover.js");
  await writeFile(texturePath, Buffer.from([1, 2, 3]));
  await writeFile(scriptPath, "pc.createScript('mover');\n");

  const requests = [];
  const handleRequest = (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: Buffer.concat(chunks) });
      res.writeHead(200, { ETag: '"test"' });
      res.end();
    });
  };
  const server = http.createServer(handleRequest);
  server.on("checkContinue", (req, res) => {
    res.writeContinue();
    handleRequest(req, res);
  });
  const port = await listen(server);
  t.after(() => new Promise((resolve) => server.close(resolve)));

  await writeFile(join(root, ".env"), [
    `PCBRIDGE_S3_ENDPOINT=http://127.0.0.1:${port}`,
    "PCBRIDGE_S3_BUCKET=root-bucket",
    "PCBRIDGE_S3_ACCESS_KEY_ID=root-key",
    "PCBRIDGE_S3_SECRET_ACCESS_KEY=root-secret",
    "PCBRIDGE_S3_PREFIX=root-prefix",
    "PCBRIDGE_S3_FORCE_PATH_STYLE=true",
  ].join("\n"));
  await mkdir(projectDirectory, { recursive: true });
  await writeFile(join(projectDirectory, ".env"), [
    "PCBRIDGE_S3_BUCKET=project-bucket",
    "PCBRIDGE_S3_ACCESS_KEY_ID=project-key",
    "PCBRIDGE_S3_SECRET_ACCESS_KEY=project-secret",
    "PCBRIDGE_S3_PREFIX=project-prefix",
    "PCBRIDGE_S3_PUBLIC_BASE_URL=https://cdn.example.com/tiny",
  ].join("\n"));

  const descriptor = {
    template: {
      id: 1,
      name: "Demo",
      type: "template",
      data: {
        entities: {
          root: {
            components: {
              render: { material: 2 },
              script: { scripts: { mover: { attributes: {} } } },
            },
          },
        },
      },
    },
    assets: [
      { id: 2, name: "Material", type: "material", data: { diffuseMap: 3 }, file: null },
      {
        id: 3,
        name: "Texture",
        type: "texture",
        data: {},
        file: {
          filename: "texture.png",
          hash: "5289df737df57326fcdd22597afb1fac",
          url: "/texture",
          variants: {
            dxt: { filename: "texture-dxt.dds", url: "/texture-dxt" },
          },
        },
      },
      {
        id: 4,
        name: "mover.js",
        type: "script",
        data: {},
        file: { filename: "mover.js", hash: "script-hash", url: "/script" },
      },
    ],
    scripts: [{ name: "mover", assetId: "4" }],
    childTemplateIds: [],
    projectUrl: "https://playcanvas.com/project/1/overview",
    sceneUrl: "https://playcanvas.com/editor/scene/1",
  };
  const workspace = {
    async prepareAssetFiles(_info, ids) {
      assert.deepEqual([...ids].sort(), ["2", "3", "4"]);
      return {
        projectDirectory,
        tmpDirectory,
        assets: [
          { id: "2", name: "Material", type: "material", filename: null, path: null, hash: null },
          { id: "3", name: "Texture", type: "texture", filename: "texture.png", path: texturePath, hash: "5289df737df57326fcdd22597afb1fac" },
          { id: "4", name: "mover.js", type: "script", filename: "mover.js", path: scriptPath, hash: "script-hash" },
        ],
      };
    },
  };
  const builder = new BuilderManager({
    rootDir: root,
    workspace,
    requestTarget: async (_target, method, params) => {
      if (method === "bridge:collectTemplateDependencies") {
        return { ok: true, data: descriptor };
      }
      assert.equal(method, "bridge:readAssetResource");
      assert.equal(params.url, "/texture-dxt");
      return {
        ok: true,
        data: { assetId: "3", filename: "texture-dxt.dds", base64: "BAUG" },
      };
    },
  });
  const started = builder.start({
    id: "tab:1",
    clientId: "client-1",
    kind: "editor",
    url: descriptor.sceneUrl,
    projectId: "1",
    projectName: "Builder",
    ready: true,
    connected: true,
    lastSeen: new Date().toISOString(),
  }, "1", { suffix: "-v1" });
  const job = await waitForJob(builder, started.id);
  assert.equal(job.state, "completed", job.error);
  assert.equal(job.configSource, "project");
  assert.equal(job.totalFiles, 4);
  assert.equal(job.completedFiles, 4);
  assert.equal(
    job.publicUrl,
    "https://cdn.example.com/tiny/project-prefix/Demo-v1/tinyapp.json",
  );
  assert.deepEqual(
    requests.map((request) => request.url).sort(),
    [
      "/project-bucket/project-prefix/Demo-v1/gamescript.js?x-id=PutObject",
      "/project-bucket/project-prefix/Demo-v1/tinyapp.json?x-id=PutObject",
      "/project-bucket/project-prefix/Demo-v1/3/texture-dxt.dds?x-id=PutObject",
      "/project-bucket/project-prefix/Demo-v1/3/texture.png?x-id=PutObject",
    ].sort(),
  );
  const tinyapp = JSON.parse(await readFile(job.outputPath, "utf8"));
  assert.equal(tinyapp.assets["2"].data.shader, "blinn");
  assert.equal(
    tinyapp.assets["3"].file.url,
    "Demo-v1/3/texture.png",
  );
  assert.equal(
    tinyapp.assets["3"].file.variants.dxt.url,
    "Demo-v1/3/texture-dxt.dds",
  );
  assert.equal(
    tinyapp.scriptUrl,
    "Demo-v1/gamescript.js",
  );
});
