// Open the picker during the click gesture, before generating or fetching data.
async function chooseExportFile(name, mime, extension) {
  if (typeof window.showSaveFilePicker !== 'function') {
    throw new Error('当前环境不支持选择保存位置，请使用启动器打开程序。');
  }
  try {
    return await window.showSaveFilePicker({
      id: 'fem-exports',
      suggestedName: name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_'),
      types: [{description: extension.slice(1).toUpperCase(), accept: {[mime]: [extension]}}],
    });
  } catch (error) {
    if (error.name === 'AbortError') return null;
    throw error;
  }
}

// close() commits the file; abort() preserves an existing file on failure.
async function writeExportFile(handle, produce) {
  const writable = await handle.createWritable();
  try {
    await produce(writable);
    await writable.close();
  } catch (error) {
    try { await writable.abort(); } catch { /* Preserve the original error. */ }
    throw error;
  }
}

async function writeExportChunks(handle, chunks) {
  await writeExportFile(handle, async writable => {
    for await (const chunk of chunks) await writable.write(chunk);
  });
}
