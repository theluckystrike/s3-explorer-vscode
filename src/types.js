'use strict';
// File types: content type for uploads, which keys open as text, and which free Zovo viewer suits a binary type.
const path = require('path');

const MIME = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values', html: 'text/html', htm: 'text/html',
  css: 'text/css', js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', jsonl: 'application/x-ndjson', ndjson: 'application/x-ndjson',
  xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', pdf: 'application/pdf',
  zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar', parquet: 'application/vnd.apache.parquet', wasm: 'application/wasm',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', ts: 'text/plain',
  py: 'text/x-python', sh: 'text/x-shellscript', sql: 'application/sql', toml: 'application/toml', ini: 'text/plain', env: 'text/plain', tf: 'text/plain',
};

const TEXT = new Set(['txt', 'log', 'md', 'markdown', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'jsonc', 'json5', 'jsonl', 'ndjson',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'sql', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh',
  'ps1', 'bat', 'tf', 'tfvars', 'hcl', 'dockerfile', 'gitignore', 'har', 'svg', 'http', 'rest', 'graphql', 'gql', 'proto', 'lua', 'r', 'swift', 'vue', 'svelte', 'tex', 'rst',
  'srt', 'vtt', 'gpx', 'kml', 'geojson', 'map', 'lock', 'gradle', 'pem', 'crt', 'pub', 'diff', 'patch', 'ipynb', 'txt~']);

// ext -> viewer. preferViewer: a text type that opens better in the viewer when it is installed.
const VIEWERS = [
  [['pdf'], 'zovo.pdf-viewer-dark', 'PDF Viewer & Reader', 'PDF'],
  [['xlsx', 'xls', 'xlsm', 'ods', 'parquet'], 'zovo.table-viewer-vscode', 'XLSX Viewer & CSV Preview', 'Excel and Parquet'],
  [['csv', 'tsv'], 'zovo.table-viewer-vscode', 'XLSX Viewer & CSV Preview', 'CSV', true],
  [['docx', 'odt'], 'zovo.docx-viewer-vscode', 'DOCX Viewer', 'Word'],
  [['pptx', 'ppt'], 'zovo.pptx-slide-viewer', 'PPTX Viewer', 'PowerPoint'],
  [['jsonl', 'ndjson'], 'zovo.zovo-jsonl-viewer', 'JSONL Viewer', 'JSONL', true],
  [['sqlite', 'sqlite3', 'db'], 'zovo.sqlite-table-viewer', 'SQLite Viewer', 'SQLite'],
  [['nc', 'h5', 'hdf5', 'he5'], 'zovo.hdf5-netcdf-explorer', 'NetCDF Viewer & HDF5 Viewer', 'NetCDF and HDF5'],
  [['npy', 'npz', 'safetensors', 'gguf', 'pt', 'pth'], 'zovo.tensor-viewer', 'NPZ Viewer & NPY Viewer', 'NumPy and tensor'],
  [['mp4', 'mov', 'mkv', 'webm', 'm4v'], 'zovo.video-preview-with-sound', 'Video Player & Preview', 'Video'],
  [['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac', 'aiff'], 'zovo.audio-preview-vscode', 'Audio Player & WAV Player', 'Audio'],
  [['tif', 'tiff'], 'zovo.tiff-viewer', 'TIFF Viewer', 'TIFF'],
  [['avro', 'arrow', 'feather'], 'zovo.arrow-avro-viewer', 'Avro and Arrow Viewer', 'Avro and Arrow'],
  [['eml', 'emlx', 'mbox'], 'zovo.eml-viewer', 'EML Viewer', 'Email'],
  [['glb', 'gltf', 'stl', 'obj', 'ply', '3mf'], 'zovo.3d-model-viewer', 'STL, OBJ, GLB & glTF Viewer', '3D model'],
  [['pkl', 'pickle'], 'zovo.zovo-pickle-viewer', 'Pickle Viewer', 'Pickle'],
  [['dcm', 'nii'], 'zovo.dicom-nifti-viewer', 'DICOM Viewer', 'DICOM and NIfTI'],
  [['epub'], 'zovo.zovo-epub-reader', 'EPUB Reader', 'EPUB'],
  [['har'], 'zovo.zovo-har-viewer', 'HAR Viewer', 'HAR', true],
  [['dxf'], 'zovo.dxf-viewer', 'DXF Viewer', 'DXF'],
];
const BY_EXT = new Map();
for (const [exts, id, name, what, preferViewer] of VIEWERS) for (const e of exts) BY_EXT.set(e, { id, name, what, preferViewer: !!preferViewer });

function extOf(key) {
  const b = path.posix.basename(key).toLowerCase();
  if (b === 'dockerfile' || b === 'makefile' || b === '.gitignore' || b === 'license' || b === 'readme') return 'txt';
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i + 1);
}

function contentTypeFor(key) { return MIME[extOf(key)] || 'application/octet-stream'; }
function isTextKey(key) { const e = extOf(key); return TEXT.has(e) || e === ''; }
function viewerFor(key) { return BY_EXT.get(extOf(key)) || null; }

module.exports = { contentTypeFor, isTextKey, viewerFor, extOf, VIEWERS };
