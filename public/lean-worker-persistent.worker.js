// Persistent Lean WASM host — Web Worker version.
//
// Runs the Lean runtime in a real Worker so the synchronous ~1-minute Init
// import happens OFF the page's main thread (a same-origin iframe shares the
// main thread, which froze the whole tab). Same boot sequence as before; the
// messaging is self.postMessage / self.onmessage instead of parent/iframe.
//
// Initializes the runtime ONCE (without running main(), which would tear it
// down via EXIT_RUNTIME=1) and serves repeated compiles through the fork's
// `lean_wasm_compile` export. The first compile imports Init and caches the
// environment inside Lean; subsequent compiles reuse it.

Error.stackTraceLimit = 1000;

let libraryFiles = [];
let moduleReady = false;
let compileBusy = false;
let compileDiagnostics = null;

const assetBase = (new URLSearchParams(location.search).get('assetBase') || '/lean-wasm').replace(/\/$/, '');
// Per-build version, appended to lean.js/lean.wasm so each build is a distinct
// (safely-immutable) CDN URL and a redeploy is picked up without a cache purge.
const assetVer = new URLSearchParams(location.search).get('v') || '';
const assetQ = assetVer ? '?v=' + encodeURIComponent(assetVer) : '';

// The build and wasmCompile emit verbose tracing; keep it out of the UI.
function isDebugLine(text) {
  return /^\s*\[(WASM DEBUG|DEBUG|IFRAME|PROFILE|PWORKER|COMPILE)/.test(text);
}

// "[DEBUG:PROGRESS] N/506" during the import -> a structured progress event so
// the loading bar can move (and now it actually can, off the main thread).
function reportImportProgress(text) {
  const m = /\[DEBUG:PROGRESS\]\s*(\d+)\/(\d+)/.exec(text);
  if (m) {
    self.postMessage({ type: 'import_progress', loaded: +m[1], total: +m[2] });
    return true;
  }
  // The build also prints bare "  - /lib/lean/<Mod>.olean" lines while loading
  // modules; keep them out of the user-visible output (the one-shot worker
  // filters the same pattern).
  return /^\s*-\s+\/lib\/lean\/.*\.olean\s*$/.test(text);
}

// Pick the largest shared wasm memory this device will actually grant.
// Desktop gets the full 2GB; iOS Safari kills the tab on a 2GB up-front
// commit (jetsam), so probe downward and boot with what fits. The build has
// ALLOW_MEMORY_GROWTH=0, so whatever we pick here is the heap for the whole
// session — maximum stays 32768 pages (2GB, virtual reservation only) to
// match the patched module's declared import.
function pickWasmMemory() {
  const PAGE = 65536;
  // iOS reports allocation success and then jetsam-kills the tab when the
  // pages are actually touched, so don't even attempt desktop-sized commits
  // there — start at 1GB and step down.
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const requestedMemoryMb = Number(new URLSearchParams(location.search).get('memoryMB'));
  const candidates = Number.isFinite(requestedMemoryMb) && requestedMemoryMb > 0
    ? [requestedMemoryMb, 1024, 768, 512].filter((value, index, values) => values.indexOf(value) === index)
    : isIOS ? [1024, 768, 512] : [2048, 1536, 1024, 768];
  for (const mb of candidates) {
    try {
      const memory = new WebAssembly.Memory({ initial: (mb * 1024 * 1024) / PAGE, maximum: 32768, shared: true });
      if (mb < 2048) console.warn('[MEM] reduced wasm memory: ' + mb + 'MB (device limit)');
      return { memory, bytes: mb * 1024 * 1024 };
    } catch (e) { /* try smaller */ }
  }
  return null; // let Emscripten try its own default and fail loudly
}

function reportRuntimeMemory(stage) {
  // Accessing Module.HEAPU8 aborts builds that do not explicitly export that
  // Emscripten runtime property. Browser heap usage is sampled externally by
  // the benchmark instead, so telemetry must never touch the Lean runtime.
  void stage;
}

function mkdirp(FS, path) {
  let current = '';
  for (const part of path.split('/').filter((p) => p)) {
    current += '/' + part;
    try { FS.mkdir(current); } catch (e) { /* exists */ }
  }
}

function writeLibFile(FS, file) {
  let fileName = file.name;
  for (const prefix of ['library/', 'lean-lib/', 'lib/lean/', 'lean/']) {
    if (fileName.startsWith(prefix)) { fileName = fileName.substring(prefix.length); break; }
  }
  const fullPath = '/lib/lean/' + fileName;
  mkdirp(FS, fullPath.substring(0, fullPath.lastIndexOf('/')));
  FS.writeFile(fullPath, new Uint8Array(file.data));
}

// Build a Lean String from a JS string (EXPORT_ALL exposes the runtime helpers).
function mkLeanString(str) {
  const ptr = Module.stringToNewUTF8(str);
  const obj = Module._lean_mk_string(ptr);
  Module._free(ptr);
  return obj;
}

function compileCode(code, fileName) {
  if (!moduleReady) return { success: false, error: 'Module not ready' };
  if (compileBusy) return { success: false, error: 'Compile already in progress' };
  compileBusy = true;
  const diagnostics = [];
  compileDiagnostics = diagnostics;
  const t0 = performance.now();
  try {
    const codeObj = mkLeanString(code);
    const fnameObj = mkLeanString(fileName || '/workspace/input.lean');
    const resObj = Module._lean_wasm_compile(codeObj, fnameObj);
    const elapsed = performance.now() - t0;
    // wasmCompile deliberately returns status 1 when elaboration produced Lean
    // diagnostics (most importantly the expected `unsolved goals` diagnostic).
    // Those diagnostics were already emitted as JSON and are the proof-state
    // payload. Calling lean_io_result_show_error here mistakes that status for
    // an IO exception and fatally exits Emscripten, preventing the next move.
    const status = Module.getValue(resObj + 7, 'i8') & 0xff;
    console.log(`[COMPILE] done in ${elapsed.toFixed(0)}ms (status ${status})`);
    return { success: true, status, elapsed, diagnostics };
  } catch (e) {
    // Never turn a process exit into a successful proof. A custom elaborator
    // can abort after emitting no diagnostic (for example an ABI assertion),
    // and treating that as success would incorrectly mark an unchecked level
    // complete. Ordinary incomplete proofs return normally with diagnostics.
    if (/Program terminated with exit\(1\)/.test((e && e.message) || String(e))) {
      return {
        success: false,
        status: 1,
        elapsed: performance.now() - t0,
        diagnostics,
        error: 'Lean WASM terminated while checking the proof',
      };
    }
    console.error('[COMPILE] threw:', e);
    return { success: false, error: (e && e.message) || String(e), diagnostics };
  } finally {
    compileDiagnostics = null;
    compileBusy = false;
  }
}

self.onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === 'load_library') {
    libraryFiles = msg.files || [];
    self.postMessage({ type: 'library_received' });
  } else if (msg.type === 'add_files') {
    let written = 0;
    for (const file of (msg.files || [])) {
      try { writeLibFile(Module.FS, file); written++; } catch (e) { /* keep going */ }
    }
    self.postMessage({ type: 'files_added', count: written });
  } else if (msg.type === 'start_worker') {
    startLeanModule();
  } else if (msg.type === 'compile') {
    self.postMessage({ type: 'compile_result', ...compileCode(msg.code, msg.path) });
    reportRuntimeMemory('compile');
  } else if (msg.type === 'load_snapshot') {
    loadSnapshot(msg.name, msg.url)
      .then((r) => { self.postMessage({ type: 'snapshot_loaded', ...r }); reportRuntimeMemory('snapshot'); })
      .catch((e) => self.postMessage({ type: 'snapshot_loaded', success: false, error: (e && e.message) || String(e) }));
  } else if (msg.type === 'load_module_bundle') {
    loadModuleBundle(msg.url)
      .then((r) => { self.postMessage({ type: 'module_bundle_loaded', ...r }); reportRuntimeMemory('modules'); })
      .catch((e) => self.postMessage({ type: 'module_bundle_loaded', success: false, error: (e && e.message) || String(e) }));
  }
};

function tarString(header, offset, length) {
  let end = offset;
  const limit = offset + length;
  while (end < limit && header[end] !== 0) end++;
  return new TextDecoder().decode(header.subarray(offset, end)).trim();
}

function tarSize(header) {
  const value = tarString(header, 124, 12).replace(/\0.*$/u, '').trim();
  return value ? Number.parseInt(value, 8) : 0;
}

function concatBytes(left, right) {
  if (!left.byteLength) return right;
  if (!right.byteLength) return left;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left, 0);
  combined.set(right, left.byteLength);
  return combined;
}

// Unpack the validated loose-module closure directly into MEMFS. Unlike a
// saved Lean heap, this contains only .olean/.ir inputs and no serialized
// environment or WASM function-table relocations. The parser consumes a USTAR
// stream incrementally, retaining at most one fetch chunk plus a 512-byte
// header while each file is written.
async function loadModuleBundle(url) {
  if (!moduleReady) return { success: false, error: 'Module not ready' };
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    return { success: false, error: `module bundle fetch: ${response.status}` };
  }

  const encodedByHttp = /\bgzip\b/iu.test(response.headers.get('content-encoding') || '');
  const needsManualDecompression = /\.gz(?:\?|$)/u.test(url) && !encodedByHttp;
  if (needsManualDecompression && typeof DecompressionStream === 'undefined') {
    return { success: false, error: 'This browser cannot stream the module bundle' };
  }

  // An HTTP Content-Encoding stream is transparently decoded before JS sees
  // it, so its compressed Content-Length cannot be compared with body bytes:
  // the count would run past the total. Report no total then.
  const contentLength = encodedByHttp ? 0 : Number(response.headers.get('content-length')) || 0;
  let downloaded = 0;
  const progressStream = new TransformStream({
    transform(chunk, controller) {
      downloaded += chunk.byteLength;
      self.postMessage({ type: 'module_bundle_progress', received: downloaded, total: contentLength });
      controller.enqueue(chunk);
    },
  });
  const body = needsManualDecompression
    ? response.body.pipeThrough(progressStream).pipeThrough(new DecompressionStream('gzip'))
    : response.body.pipeThrough(progressStream);

  const FS = Module.FS;
  const reader = body.getReader();
  let pending = new Uint8Array(0);
  let state = 'header';
  let file = null;
  let remaining = 0;
  let padding = 0;
  let files = 0;
  let expanded = 0;
  let archiveEnded = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done && !value) break;
    pending = concatBytes(pending, value || new Uint8Array(0));

    for (;;) {
      if (state === 'header') {
        if (pending.byteLength < 512) break;
        const header = pending.subarray(0, 512);
        pending = pending.subarray(512);
        if (header.every((byte) => byte === 0)) {
          archiveEnded = true;
          break;
        }
        const name = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 155);
        const relative = `${prefix ? prefix + '/' : ''}${name}`.replace(/^\.\//u, '');
        const type = String.fromCharCode(header[156] || 0);
        const size = tarSize(header);
        // `tar -C <directory> .` emits `./` as its first entry. It is only the
        // archive's root directory marker, so normalization intentionally
        // turns it into an empty relative path and there is nothing to create.
        if (!relative && type === '5') continue;
        if (!relative || relative.startsWith('/') || relative.split('/').includes('..')) {
          throw new Error(`unsafe module bundle path: ${relative || '(empty)'}`);
        }
        if (type === '5') {
          mkdirp(FS, '/lib/lean/' + relative.replace(/\/$/u, ''));
          continue;
        }
        if (type !== '\0' && type !== '0') {
          throw new Error(`unsupported module bundle entry type ${JSON.stringify(type)} for ${relative}`);
        }
        const target = '/lib/lean/' + relative;
        mkdirp(FS, target.substring(0, target.lastIndexOf('/')));
        file = FS.open(target, 'w');
        remaining = size;
        padding = (512 - (size % 512)) % 512;
        files++;
        state = remaining > 0 ? 'file' : 'padding';
        if (remaining === 0) {
          FS.close(file);
          file = null;
        }
      } else if (state === 'file') {
        if (!pending.byteLength) break;
        const count = Math.min(remaining, pending.byteLength);
        FS.write(file, pending, 0, count);
        pending = pending.subarray(count);
        remaining -= count;
        expanded += count;
        if (remaining === 0) {
          FS.close(file);
          file = null;
          state = 'padding';
        }
      } else {
        if (pending.byteLength < padding) break;
        pending = pending.subarray(padding);
        padding = 0;
        state = 'header';
      }
    }
    if (archiveEnded) break;
  }

  if (!archiveEnded || state !== 'header' || file) {
    if (file) FS.close(file);
    return { success: false, error: 'truncated module bundle' };
  }
  self.postMessage({ type: 'module_bundle_progress', received: downloaded, total: contentLength || downloaded });
  console.log(`[MODULES] loaded ${files} files (${expanded} bytes) from ${downloaded} downloaded bytes`);
  return { success: true, files, expanded };
}

// Seed Lean's environment cache from a baked `--incr-header-save` snapshot,
// replacing the multi-minute Init import. The snapshot is githash-paired with
// lean.wasm (its closure relocation is only valid for that binary), which the
// app guarantees by requesting it under the same ?v= as the binary itself.
//
// The worker fetches and decompresses the snapshot off the main thread. New
// runtimes mount the result through WORKERFS so it does not occupy MEMFS while
// Lean maps the compact region; older artifacts retain the streaming fallback.
//
// OPFS-capable browsers stream the expanded snapshot to browser-managed disk;
// the fallback still avoids transferring it through the page's main thread.
async function streamSnapshotToOpfs(body, fileName) {
  if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') return null;

  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle('visual-lean-snapshots', { create: true });
  const handle = await directory.getFileHandle(fileName, { create: true });
  const writable = await handle.createWritable();
  const reader = body.getReader();
  let received = 0;
  let first = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (first) {
        first = false;
        if (value.length < 5 || value[0] !== 0x6f || value[1] !== 0x6c || value[2] !== 0x65 || value[3] !== 0x61 || value[4] !== 0x6e) {
          throw new Error('snapshot fetch returned non-olean content');
        }
      }
      await writable.write(value);
      received += value.length;
    }
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch (abortError) { /* ignore */ }
    try { await directory.removeEntry(fileName); } catch (removeError) { /* ignore */ }
    throw error;
  }

  const file = await handle.getFile();
  return {
    file,
    received,
    cleanup: async () => {
      try { await directory.removeEntry(fileName); } catch (error) { /* ignore */ }
    },
  };
}

async function loadSnapshot(name, url) {
  if (!moduleReady) return { success: false, error: 'Module not ready' };
  const t0 = performance.now();
  const FS = Module.FS;
  const p = '/snapshots/' + (name || 'init.snap');
  let mountedWorkerFs = false;
  let removeOpfsSnapshot = null;
  try {
    const response = await fetch(url);
    if (!response.ok || !response.body) return { success: false, error: `snapshot fetch: ${response.status}` };
    // Fetch transparently decodes HTTP `Content-Encoding: gzip` (as Vite and
    // most static hosts serve `.gz` assets). Only decode manually when the
    // host serves the gzip bytes without that response header.
    const encodedByHttp = /\bgzip\b/iu.test(response.headers.get('content-encoding') || '');
    const needsManualDecompression = /\.gz(?:\?|$)/u.test(url) && !encodedByHttp;
    if (needsManualDecompression && typeof DecompressionStream === 'undefined') {
      return { success: false, error: 'This browser cannot stream gzip snapshots' };
    }
    // Stream decompression directly into MEMFS.  This avoids retaining a
    // compressed ArrayBuffer alongside the restored Lean environment.
    const contentLength = Number(response.headers.get('content-length')) || 0;
    let compressedReceived = 0;
    const compressedProgress = needsManualDecompression
      ? new TransformStream({
          transform(chunk, controller) {
            compressedReceived += chunk.byteLength;
            self.postMessage({
              type: 'snapshot_progress',
              received: compressedReceived,
              total: contentLength,
            });
            controller.enqueue(chunk);
          },
        })
      : null;
    const body = needsManualDecompression
      ? response.body
          .pipeThrough(compressedProgress)
          .pipeThrough(new DecompressionStream('gzip'))
      : response.body;
    // An HTTP Content-Encoding stream is transparently decoded before JS sees
    // it, so its compressed Content-Length cannot be compared with body bytes.
    const total = encodedByHttp ? 0 : contentLength;
    try { FS.mkdir('/snapshots'); } catch (e) { /* exists */ }
    let received = 0;

    // Prefer an OPFS-backed File. Unlike Response.blob(), this streams the
    // expanded 475MB snapshot to browser-managed disk without materializing it
    // in the tab's memory before Lean begins restoration.
    if (typeof WORKERFS === 'object' && typeof Blob !== 'undefined') {
      const fileName = name || 'init.snap';
      const opfsSnapshot = await streamSnapshotToOpfs(body, fileName);
      let snapshotFile;
      let snapshotMount;
      if (opfsSnapshot) {
        snapshotFile = opfsSnapshot.file;
        received = opfsSnapshot.received;
        removeOpfsSnapshot = opfsSnapshot.cleanup;
        snapshotMount = { files: [snapshotFile] };
      } else {
        snapshotFile = await new Response(body).blob();
        received = snapshotFile.size;
        const magic = new Uint8Array(await snapshotFile.slice(0, 5).arrayBuffer());
        if (magic.length < 5 || magic[0] !== 0x6f || magic[1] !== 0x6c || magic[2] !== 0x65 || magic[3] !== 0x61 || magic[4] !== 0x6e) {
          return { success: false, error: 'snapshot fetch returned non-olean content' };
        }
        snapshotMount = { blobs: [{ name: fileName, data: snapshotFile }] };
      }
      FS.mount(WORKERFS, {
        ...snapshotMount,
        blobs: [
          ...(snapshotMount.blobs || []),
          { name: (name || 'init.snap') + '.deps', data: new Blob(['[]']) },
        ],
      }, '/snapshots');
      mountedWorkerFs = true;
    } else {
      const reader = body.getReader();
      const stream = FS.open(p, 'w');
      let lastReport = 0;
      let first = true;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // Guard against an SPA fallback page served with 200: snapshots are
        // compacted-region files and start with the olean magic.
        if (first) {
          first = false;
          if (value.length < 5 || value[0] !== 0x6f || value[1] !== 0x6c || value[2] !== 0x65 || value[3] !== 0x61 || value[4] !== 0x6e) {
            FS.close(stream);
            try { FS.unlink(p); } catch (e) { /* ignore */ }
            return { success: false, error: 'snapshot fetch returned non-olean content' };
          }
        }
        FS.write(stream, value, 0, value.length, received);
        received += value.length;
        if (!needsManualDecompression && received - lastReport > 8 * 1024 * 1024) {
          lastReport = received;
          self.postMessage({ type: 'snapshot_progress', received, total });
        }
      }
      FS.close(stream);
      // The loader reads a `<file>.deps` sidecar; self-contained snapshots use `[]`.
      FS.writeFile(p + '.deps', new Uint8Array([0x5b, 0x5d]));
    }
    if (needsManualDecompression) {
      self.postMessage({
        type: 'snapshot_progress',
        received: compressedReceived,
        total: contentLength || compressedReceived,
      });
    } else {
      self.postMessage({ type: 'snapshot_progress', received, total: total || received });
    }
    const resObj = Module._lean_wasm_load_snapshot(mkLeanString(p));
    const tag = Module.getValue(resObj + 7, 'i8') & 0xff;
    // The ok value is a UInt32, which wasm32 heap-boxes: field 0 points to a
    // scalar-box object with the payload at +8. 0 = loaded, 1 = load failed.
    const boxPtr = Module.getValue(resObj + 8, 'i32');
    const ret = Module.getValue(boxPtr + 8, 'i32');
    const success = tag === 0 && ret === 0;
    // The Blob mount or MEMFS copy served its purpose; the environment holds
    // the loaded compact region after this call returns.
    if (mountedWorkerFs) {
      try { FS.unmount('/snapshots'); } catch (e) { /* ignore */ }
      mountedWorkerFs = false;
      if (removeOpfsSnapshot) await removeOpfsSnapshot();
      removeOpfsSnapshot = null;
    } else {
      try { FS.unlink(p); FS.unlink(p + '.deps'); } catch (e) { /* ignore */ }
    }
    const elapsed = performance.now() - t0;
    console.log(`[SNAPSHOT] load ${success ? 'ok' : 'FAILED'} in ${elapsed.toFixed(0)}ms (tag ${tag}, ret ${ret})`);
    return { success, elapsed };
  } catch (e) {
    if (mountedWorkerFs) {
      try { FS.unmount('/snapshots'); } catch (e2) { /* ignore */ }
    } else {
      try { FS.unlink(p); } catch (e2) { /* ignore */ }
    }
    if (removeOpfsSnapshot) await removeOpfsSnapshot();
    console.error('[SNAPSHOT] threw:', e);
    return { success: false, error: (e && e.message) || String(e) };
  }
}

function startLeanModule() {
  self.postMessage({ type: 'startup_stage', data: 'configuring runtime' });
  self.Module = {
    // The paired runtime owns its shared, growable memory declaration (64MB
    // initially, 4GB maximum). Its maximum must match the pthread module.
    locateFile: (path) => assetBase + '/' + path + assetQ,
    // Tell Emscripten where the runtime script is, so the pthread sub-workers
    // this Worker spawns can load lean.js (the Worker's own script is this file).
    mainScriptUrlOrBlob: assetBase + '/lean.js' + assetQ,
    print: (text) => {
      if (reportImportProgress(text)) return;
      if (isDebugLine(text)) console.log(text);
      else {
        if (compileDiagnostics) {
          try { compileDiagnostics.push(JSON.parse(String(text))); } catch (e) { /* not a diagnostic */ }
        }
        self.postMessage({ type: 'stdout', data: text });
      }
    },
    printErr: (text) => { if (reportImportProgress(text)) return; if (isDebugLine(text)) console.log(text); else self.postMessage({ type: 'stderr', data: text }); },
    setStatus: (text) => { if (text) self.postMessage({ type: 'progress', data: text }); },
    noInitialRun: true,

    preRun: [function () {
      const FS = Module.FS;
      Module.ENV['LEAN_PATH'] = '/lib/lean';
      for (const d of ['/lib', '/lib/lean', '/workspace', '/bin']) { try { FS.mkdir(d); } catch (e) { /* exists */ } }
      let errors = 0;
      for (const file of libraryFiles) { try { writeLibFile(FS, file); } catch (e) { errors++; } }
      if (errors > 0) console.error('library write errors:', errors);
      libraryFiles = []; // release the transferred buffers
      try { FS.chdir('/workspace'); } catch (e) { /* ignore */ }
    }],

    onRuntimeInitialized: function () {
      try {
        self.postMessage({ type: 'startup_stage', data: 'initializing Lean runtime' });
        Module._lean_initialize_runtime_module();
        Module._lean_initialize();
        Module._lean_io_mark_end_initialization();
        const runtimeThreads = Number(self.__LEAN_RUNTIME_THREADS);
        if (runtimeThreads > 0 && Module._lean_init_task_manager_using) {
          Module._lean_init_task_manager_using(runtimeThreads);
        } else if (Module._lean_init_task_manager) {
          Module._lean_init_task_manager();
        }
        // Hold the Emscripten runtime for the worker's lifetime. Incomplete Lean
        // proofs intentionally return process status 1 after emitting their
        // `unsolved goals` diagnostics; without this keepalive, that status
        // destroys the heap and pthread pool before the player's next move.
        Module.runtimeKeepalivePush();
        if (Module._lean_enable_initializer_execution) Module._lean_enable_initializer_execution();
        const spRes = Module._lean_init_search_path();
        if ((Module.getValue(spRes + 7, 'i8') & 0xff) !== 0) {
          try { Module._lean_io_result_show_error(spRes); } catch (e) { /* ignore */ }
          throw new Error('lean_init_search_path failed (see stderr)');
        }
        moduleReady = true;
        self.postMessage({ type: 'startup_stage', data: 'Lean runtime ready' });
        self.postMessage({ type: 'worker_ready' });
        reportRuntimeMemory('ready');
      } catch (e) {
        self.postMessage({ type: 'error', data: 'Lean init failed: ' + ((e && e.message) || e) });
      }
    },

    onAbort: function (what) {
      moduleReady = false;
      self.postMessage({ type: 'error', data: 'Aborted: ' + (what || 'unknown') });
    },
  };

  try {
    self.postMessage({ type: 'startup_stage', data: 'loading runtime script' });
    importScripts(assetBase + '/lean.js' + assetQ);
    self.postMessage({ type: 'startup_stage', data: 'runtime script loaded' });
  } catch (e) {
    self.postMessage({ type: 'error', data: 'Failed to load lean.js: ' + ((e && e.message) || e) });
  }
}

self.postMessage({ type: 'worker_boot' });
