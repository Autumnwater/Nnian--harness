import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const stableValue = value => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => {
        if (value[key] === undefined) return null;
        return [key, stableValue(value[key])];
      }).filter(Boolean)
    );
  }
  return value;
};

export const canonicalJson = value => JSON.stringify(stableValue(value));

export const canonicalHash = value => `sha256:${createHash('sha256')
  .update(canonicalJson(value))
  .digest('hex')}`;

export const sha256Text = value => `sha256:${createHash('sha256')
  .update(String(value))
  .digest('hex')}`;

export const hmacSha256 = (secret, value) => `hmac-sha256:${createHmac('sha256', secret)
  .update(canonicalJson(value))
  .digest('hex')}`;

export const timingSafeEqualString = (left, right) => {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;
  return timingSafeEqual(Buffer.from(left), Buffer.from(right));
};

export const ensureDir = directory => fs.mkdirSync(directory, { recursive: true });

const assertRelativeInside = (targetPath, rootPath) => {
  const relative = path.relative(rootPath, targetPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path-outside-allowlist: ${targetPath}`);
  }
  return relative;
};

export const ensureDirInsideRoot = (directory, rootPath) => {
  const rootReal = fs.realpathSync(rootPath);
  const rootAbsolute = path.resolve(rootPath);
  const directoryAbsolute = path.resolve(directory);
  const relative = assertRelativeInside(directoryAbsolute, rootAbsolute);
  if (!relative) return rootReal;

  let current = rootAbsolute;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const currentReal = fs.realpathSync(current);
      assertRelativeInside(currentReal, rootReal);
      if (!fs.statSync(currentReal).isDirectory()) throw new Error(`path-not-directory: ${current}`);
      continue;
    }
    fs.mkdirSync(current);
    const createdReal = fs.realpathSync(current);
    assertRelativeInside(createdReal, rootReal);
  }
  return fs.realpathSync(directoryAbsolute);
};

export const fsyncDirectory = directory => {
  const fd = fs.openSync(directory, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
};

export const atomicWriteFile = (filePath, contents, { mode = 0o600, faultInjector = null } = {}) => {
  const directory = path.dirname(filePath);
  ensureDir(directory);
  const tempPath = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tempPath, 'wx', mode);
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    faultInjector?.('before-file-rename', { filePath, tempPath });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, mode);
    fsyncDirectory(directory);
    faultInjector?.('after-file-rename', { filePath });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch {
      // Temporary files are never authoritative.
    }
  }
};

export const atomicWriteJson = (filePath, value, { faultInjector = null } = {}) =>
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, faultInjector });

export const readJson = filePath => {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`corrupt-json-record: ${filePath}: ${error.message}`);
  }
};

export const listJsonFiles = directory => {
  if (!fs.existsSync(directory)) return [];
  const output = [];
  const visit = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.json')) output.push(entryPath);
    }
  };
  visit(directory);
  return output.sort();
};

export const recoverJsonl = filePath => {
  if (!fs.existsSync(filePath)) return { truncated: false };
  const contents = fs.readFileSync(filePath);
  if (contents.length === 0 || contents.at(-1) === 0x0a) return { truncated: false };
  const lastNewline = contents.lastIndexOf(0x0a);
  const validLength = lastNewline < 0 ? 0 : lastNewline + 1;
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.ftruncateSync(fd, validLength);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectory(path.dirname(filePath));
  return { truncated: true, removedBytes: contents.length - validLength };
};

export const appendJsonLine = (filePath, value, { faultInjector = null } = {}) => {
  recoverJsonl(filePath);
  ensureDir(path.dirname(filePath));
  const fd = fs.openSync(filePath, 'a', 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(value)}\n`, undefined, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  faultInjector?.('after-jsonl-append', { filePath, value });
};

export const readJsonLines = filePath => {
  recoverJsonl(filePath);
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line));
};

export const resolveInsideRoot = (targetPath, rootPath, { allowMissingLeaf = false } = {}) => {
  const rootReal = fs.realpathSync(rootPath);
  const targetExists = fs.existsSync(targetPath);
  const realTarget = targetExists
    ? fs.realpathSync(targetPath)
    : (() => {
        if (!allowMissingLeaf) throw new Error(`path-missing: ${targetPath}`);
        const parent = path.dirname(targetPath);
        if (!fs.existsSync(parent)) throw new Error(`path-parent-missing: ${targetPath}`);
        return path.join(fs.realpathSync(parent), path.basename(targetPath));
      })();
  assertRelativeInside(realTarget, rootReal);
  return realTarget;
};
