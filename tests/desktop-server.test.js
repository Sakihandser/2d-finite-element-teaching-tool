"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {spawn} = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const net = require("node:net");
const {once} = require("node:events");

// Isolated copies avoid rewriting the user's material-library script at startup.
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "fem-desktop-server-"));
  t.after(() => fs.rm(directory, {recursive:true, force:true}));
  const root = path.join(__dirname, "..");
  for (const file of await fs.readdir(root)) if (file.endsWith(".js")) await fs.copyFile(path.join(root,file), path.join(directory,file));
  await fs.writeFile(path.join(directory,"index.html"), "<title>Desktop server test</title>");
  return directory;
}
function launch(t, directory, port) {
  const child = spawn(process.execPath, [path.join(directory,"server.js")], {
    cwd:directory, windowsHide:true, stdio:["pipe","pipe","pipe"],
    env:{...process.env, FEM_OPEN_BROWSER:"0", FEM_DESKTOP:"1", PORT:String(port)},
  });
  let output = "", errors = "";
  child.stderr.on("data", data => { errors += data; });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const closed = once(child,"exit");
  const ready = new Promise((resolve,reject) => {
    const timeout = setTimeout(() => reject(new Error("Readiness timeout: " + output + errors)), 10000);
    child.once("error", error => {clearTimeout(timeout); reject(error);});
    child.once("exit", () => {clearTimeout(timeout); reject(new Error("Exited before ready: " + output + errors));});
    child.stdout.on("data", data => {
      output += data;
      const match = output.match(/^FEM_DESKTOP_READY (.+)\r?$/m);
      if (match) { clearTimeout(timeout); resolve(JSON.parse(match[1])); }
    });
  });
  return {child, ready, closed, errors:() => errors};
}
function get(url) {
  return new Promise((resolve,reject) => {
    http.get(url, response => {
      let body=""; response.on("data",data=>{body+=data;});
      response.on("end",()=>resolve({status:response.statusCode,body}));
    }).on("error",reject);
  });
}
async function within(promise, ms=5000) {
  let timer;
  try {return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("Shutdown timeout")),ms);})]);}
  finally {clearTimeout(timer);}
}

test("desktop service reports the actual ephemeral port and exits when owner pipe closes", async t => {
  const directory = await fixture(t);
  const app = launch(t,directory,0);
  const ready = await app.ready;
  assert.equal(ready.pid,app.child.pid);
  assert.ok(ready.port>0);
  assert.equal(ready.url,`http://127.0.0.1:${ready.port}/`);
  const response=await get(ready.url);
  assert.equal(response.status,200);
  assert.match(response.body,/Desktop server test/);
  app.child.stdin.end();
  const [code]=await within(app.closed);
  assert.equal(code,0,app.errors());
  await assert.rejects(get(ready.url),{code:"ECONNREFUSED"});
});

test("desktop service skips an occupied port without attaching to or stopping its owner", async t => {
  const directory=await fixture(t);
  const occupied=net.createServer(socket=>socket.end());
  await new Promise(resolve=>occupied.listen(0,"127.0.0.1",resolve));
  t.after(()=>occupied.close());
  const firstPort=occupied.address().port;
  const app=launch(t,directory,firstPort);
  const ready=await app.ready;
  assert.notEqual(ready.port,firstPort);
  assert.ok(ready.port>firstPort && ready.port<=firstPort+20);
  assert.equal((await get(ready.url)).status,200);
  app.child.stdin.write("shutdown\n");
  assert.equal((await within(app.closed))[0],0,app.errors());
  assert.equal(occupied.listening,true);
  assert.doesNotMatch(app.errors(),/MaxListenersExceededWarning|ERR_SERVER_NOT_RUNNING/);
});

test("desktop shutdown also closes active HTTP connections", async t => {
  const directory=await fixture(t);
  const app=launch(t,directory,0);
  const ready=await app.ready;
  const socket=net.connect(ready.port,"127.0.0.1");
  t.after(()=>socket.destroy());
  await once(socket,"connect");
  // An incomplete POST would otherwise hold server.close() open indefinitely.
  socket.write("POST /api/materials HTTP/1.1\r\nHost: localhost\r\nContent-Length: 200\r\n\r\n{");
  app.child.stdin.end();
  assert.equal((await within(app.closed))[0],0);
});
