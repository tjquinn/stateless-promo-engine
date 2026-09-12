const express = require('express');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { evaluateCart } = require('./engine');

const app = express();
const rootDir = __dirname;
const dataDir = path.join(rootDir, 'data');
const productsPath = path.join(dataDir, 'products.json');
const promoDirectory = path.join(dataDir, 'promotions');

const state = {
  products: [],
  pricingBySku: new Map(),
  promotions: [],
};

function runGitCommand(args, options = {}) {
  const defaultOptions = { cwd: rootDir, encoding: 'utf8' };
  const result = spawnSync('git', args, { ...defaultOptions, ...options });

  if (result.error) {
    throw result.error;
  }

  if ((result.status !== 0) && !options.allowFailure) {
    const errorOutput = (result.stderr || result.stdout || '').trim();
    throw new Error(errorOutput || `Git command failed: ${args.join(' ')}`);
  }

  return (result.stdout || '').trim();
}

function ensureRepo() {
  if (!fs.existsSync(path.join(rootDir, '.git'))) {
    runGitCommand(['init']);
    runGitCommand(['config', 'user.name', 'Stateless Commerce Bot']);
    runGitCommand(['config', 'user.email', 'bot@local.invalid']);
  }
}

function ensureDataDirectories() {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(promoDirectory, { recursive: true });
  if (!fs.existsSync(productsPath)) {
    fs.writeFileSync(productsPath, JSON.stringify([], null, 2));
  }
}

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
}

function normalizeProduct(product) {
  return {
    sku: String(product.sku),
    name: String(product.name),
    category: String(product.category || 'general'),
    price: Number(product.price) || 0,
  };
}

function normalizePromotion(rawPromotion) {
  if (!rawPromotion || !rawPromotion.code) {
    return null;
  }

  const startAtMs = rawPromotion.start_at ? Date.parse(rawPromotion.start_at) : null;
  const endAtMs = rawPromotion.end_at ? Date.parse(rawPromotion.end_at) : null;
  const code = String(rawPromotion.code);
  const inferredName = code
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    code,
    name: String(rawPromotion.name || inferredName || code),
    required_set: rawPromotion.required_set || { items: [] },
    reward: rawPromotion.reward || {},
    start_at: rawPromotion.start_at || null,
    end_at: rawPromotion.end_at || null,
    start_at_ms: Number.isNaN(startAtMs) ? null : startAtMs,
    end_at_ms: Number.isNaN(endAtMs) ? null : endAtMs,
    retired: Boolean(rawPromotion.retired),
    last_edited: Number(rawPromotion.last_edited) || null,
  };
}

function loadConfigurationsIntoMemory() {
  ensureDataDirectories();

  const productList = readJsonFile(productsPath);
  const products = Array.isArray(productList) ? productList.map(normalizeProduct) : [];
  const pricingBySku = new Map();

  for (const product of products) {
    pricingBySku.set(product.sku, product);
  }

  const promotionFiles = fs.existsSync(promoDirectory)
    ? fs.readdirSync(promoDirectory)
        .filter((file) => file.endsWith('.json'))
        .sort()
    : [];

  const promotions = [];

  for (const fileName of promotionFiles) {
    const filePath = path.join(promoDirectory, fileName);
    const parsed = readJsonFile(filePath);
    const mtimeMs = fs.existsSync(filePath) ? fs.statSync(filePath).mtimeMs : 0;
    const normalized = normalizePromotion({ ...parsed, last_edited: mtimeMs });
    if (normalized) {
      promotions.push(normalized);
    }
  }

  promotions.sort((left, right) => {
    const leftTimestamp = Number(left.last_edited) || 0;
    const rightTimestamp = Number(right.last_edited) || 0;
    return rightTimestamp - leftTimestamp;
  });

  state.products = products;
  state.pricingBySku = pricingBySku;
  state.promotions = promotions;

  return {
    productCount: products.length,
    promotionCount: promotions.length,
    loadedAt: new Date().toISOString(),
  };
}

function parseMultipartRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks);
      const contentType = req.headers['content-type'] || '';
      const boundaryMatch = contentType.match(/boundary=(.*)$/);

      if (!boundaryMatch) {
        resolve({ fields: {} });
        return;
      }

      const boundary = `--${boundaryMatch[1].replace(/"/g, '')}`;
      const text = rawBody.toString('utf8');
      const segments = text.split(boundary).filter((segment) => segment.trim() && segment.trim() !== '--');
      const fields = {};

      for (const segment of segments) {
        const normalizedSegment = segment.replace(/^\r\n/, '').replace(/\r\n$/, '');
        const headerIndex = normalizedSegment.indexOf('\r\n\r\n');
        if (headerIndex === -1) {
          continue;
        }

        const headerBlock = normalizedSegment.slice(0, headerIndex);
        const body = normalizedSegment.slice(headerIndex + 4).replace(/\r\n$/, '');
        const nameMatch = headerBlock.match(/name="([^"]+)"/i);

        if (!nameMatch) {
          continue;
        }

        const fieldName = nameMatch[1];
        if (!fields[fieldName]) {
          fields[fieldName] = [];
        }
        fields[fieldName].push(body);
      }

      resolve({ fields });
    });
    req.on('error', reject);
  });
}

function getGitShortHash() {
  return runGitCommand(['rev-parse', '--short', 'HEAD'], { allowFailure: true });
}

function getRepoStatus() {
  return runGitCommand(['status', '--porcelain'], { allowFailure: true });
}

function setValueByPath(target, fieldPath, value) {
  if (!fieldPath || !target || typeof target !== 'object') {
    return;
  }

  const segments = fieldPath.split('.').map((segment) => {
    const arrayMatch = segment.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      return { key: arrayMatch[1], index: Number(arrayMatch[2]) };
    }
    return segment;
  });

  let current = target;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    const isLast = index === segments.length - 1;
    const key = typeof segment === 'string' ? segment : segment.key;
    const arrayIndex = typeof segment === 'string' ? null : segment.index;

    if (isLast) {
      if (arrayIndex !== null) {
        current[key][arrayIndex] = value;
      } else {
        current[key] = value;
      }
      return;
    }

    if (arrayIndex !== null) {
      current = current[key][arrayIndex];
    } else {
      current = current[key];
    }
  }
}

function getValueByPath(target, fieldPath) {
  if (!fieldPath || !target || typeof target !== 'object') {
    return undefined;
  }

  const segments = fieldPath.split('.').map((segment) => {
    const arrayMatch = segment.match(/^([^\[]+)\[(\d+)\]$/);
    if (arrayMatch) {
      return { key: arrayMatch[1], index: Number(arrayMatch[2]) };
    }
    return segment;
  });

  let current = target;

  for (const segment of segments) {
    const key = typeof segment === 'string' ? segment : segment.key;
    const arrayIndex = typeof segment === 'string' ? null : segment.index;

    if (!current || typeof current !== 'object' || !(key in current)) {
      return undefined;
    }

    current = current[key];

    if (arrayIndex !== null) {
      if (!Array.isArray(current) || current[arrayIndex] === undefined) {
        return undefined;
      }
      current = current[arrayIndex];
    }
  }

  return current;
}

function valuesAreEqual(left, right) {
  if (left === right) {
    return true;
  }

  if (typeof left === 'number' && typeof right === 'number' && Number.isNaN(left) && Number.isNaN(right)) {
    return true;
  }

  if ((typeof left === 'object' && left !== null) || (typeof right === 'object' && right !== null)) {
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch (error) {
      return false;
    }
  }

  return false;
}

function parseJsonSafely(text) {
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function parseFieldValue(value, fieldPath) {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (fieldPath === 'retired') {
      return trimmed === 'true';
    }

    if (fieldPath === 'required_set.items[0].quantity' || fieldPath === 'reward.discount_value' || fieldPath === 'reward.discount_value' || fieldPath === 'match_quantity') {
      const numberValue = Number(trimmed);
      return Number.isNaN(numberValue) ? trimmed : numberValue;
    }

    if (trimmed === 'true' || trimmed === 'false') {
      return trimmed === 'true';
    }

    if (/^\d+(\.\d+)?$/.test(trimmed)) {
      return Number(trimmed);
    }
  }

  return value;
}

function getPromotionHistory(fileName) {
  const fullPath = path.join(promoDirectory, fileName);
  if (!fs.existsSync(fullPath)) {
    return [];
  }

  const logOutput = runGitCommand(['log', '--follow', '--format=%H%x09%ct%x09%s', '--', `data/promotions/${fileName}`], { allowFailure: true });
  const entries = logOutput ? logOutput.split('\n').filter(Boolean) : [];
  const history = [];

  for (let index = 0; index < entries.length; index += 1) {
    const [commitHash, timestamp, subject] = entries[index].split('\t');
    const date = timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null;
    let diff = '';
    let snapshot = null;

    if (index === 0) {
      diff = runGitCommand(['show', '--format=', '--no-ext-diff', '--patch', commitHash, '--', `data/promotions/${fileName}`], { allowFailure: true });
    } else {
      const previousHash = entries[index - 1].split('\t')[0];
      diff = runGitCommand(['diff', previousHash, commitHash, '--', `data/promotions/${fileName}`], { allowFailure: true });
    }

    const snapshotText = runGitCommand(['show', `${commitHash}:data/promotions/${fileName}`], { allowFailure: true });
    try {
      snapshot = snapshotText ? JSON.parse(snapshotText) : null;
    } catch (error) {
      snapshot = null;
    }

    history.push({
      commitHash,
      subject: subject || 'Promotion updated',
      timestamp: date,
      diff: diff.trim() || 'Initial promotion created.',
      snapshot,
    });
  }

  return history;
}

class PromotionFilter {
  static selectEligible(promotions, promoCode, nowMs) {
    const normalizedPromoCode = String(promoCode || '').trim();

    return promotions.filter((promotion) => {
      if (promotion.retired) {
        return false;
      }

      if (promotion.start_at_ms !== null && promotion.start_at_ms > nowMs) {
        return false;
      }

      if (promotion.end_at_ms !== null && promotion.end_at_ms < nowMs) {
        return false;
      }

      if (normalizedPromoCode) {
        const normalizedPromotionCode = String(promotion.code || '').trim();
        if (normalizedPromotionCode.toUpperCase() !== normalizedPromoCode.toUpperCase()) {
          return false;
        }
      }

      return true;
    });
  }
}

class CheckoutService {
  static buildSecureCart(rawItems, pricingBySku) {
    const secureCart = [];

    for (const entry of rawItems) {
      const sku = String(entry.sku || '').trim();
      const quantity = Number(entry.quantity) || 0;
      if (!sku || quantity <= 0) {
        continue;
      }

      const product = pricingBySku.get(sku);
      if (!product) {
        throw new Error(`Unknown product SKU: ${sku}`);
      }

      secureCart.push({
        sku: product.sku,
        category: product.category,
        name: product.name,
        unitPrice: product.price,
        quantity,
      });
    }

    if (!secureCart.length) {
      throw new Error('No valid cart entries were provided.');
    }

    return secureCart;
  }

  static evaluate({ rawItems, promoCode, pricingBySku, promotions }) {
    const secureCart = CheckoutService.buildSecureCart(rawItems, pricingBySku);
    const matchingPromotions = PromotionFilter.selectEligible(promotions, promoCode, Date.now());
    return evaluateCart(secureCart, matchingPromotions);
  }
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(rootDir));

app.get('/api/products', (req, res) => {
  res.json({ products: state.products });
});

app.get('/api/admin/promotions', (req, res) => {
  res.json({ promotions: state.promotions });
});

app.post('/api/admin/git-sync', (req, res) => {
  try {
    ensureRepo();
    const status = getRepoStatus();

    if (status.trim()) {
      return res.status(409).json({
        ok: false,
        message: 'Repository is not clean; commit or revert working tree changes before syncing.',
        gitStatus: status,
      });
    }

    const summary = loadConfigurationsIntoMemory();
    const gitHash = getGitShortHash();

    return res.json({
      ok: true,
      gitHash,
      configSummary: summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/save-promotion', async (req, res) => {
  try {
    ensureRepo();
    const multipart = await parseMultipartRequest(req);
    const code = (multipart.fields.code && multipart.fields.code[0]) || '';
    const definitionText = (multipart.fields.definition && multipart.fields.definition[0]) || '';

    if (!code || !definitionText) {
      return res.status(400).json({ ok: false, message: 'Code and promotion definition are required.' });
    }

    const config = JSON.parse(definitionText);
    config.code = code;
    if (config.start_at === undefined) {
      config.start_at = null;
    }
    if (config.end_at === undefined) {
      config.end_at = null;
    }
    if (config.retired === undefined) {
      config.retired = false;
    }

    const fileName = `${code.toLowerCase()}.json`;
    const filePath = path.join(promoDirectory, fileName);
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));

    runGitCommand(['add', `data/promotions/${fileName}`]);
    const commitMessage = `Add promotion ${code}`;
    const commitOutput = runGitCommand(['commit', '-m', commitMessage], { allowFailure: true });

    const summary = loadConfigurationsIntoMemory();
    const gitHash = getGitShortHash();

    return res.json({
      ok: true,
      fileName,
      commitOutput,
      gitHash,
      configSummary: summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/set-retired', (req, res) => {
  try {
    ensureRepo();
    const { code, retired } = req.body || {};

    if (!code) {
      return res.status(400).json({ ok: false, message: 'Promotion code is required.' });
    }

    const fileName = `${String(code).toLowerCase()}.json`;
    const filePath = path.join(promoDirectory, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: `Promotion ${code} was not found.` });
    }

    const promotion = readJsonFile(filePath);
    promotion.retired = Boolean(retired);
    fs.writeFileSync(filePath, JSON.stringify(promotion, null, 2));

    runGitCommand(['add', `data/promotions/${fileName}`]);
    const commitMessage = `Retire promotion ${code}`;
    const commitOutput = runGitCommand(['commit', '-m', commitMessage], { allowFailure: true });

    const summary = loadConfigurationsIntoMemory();
    const gitHash = getGitShortHash();

    return res.json({
      ok: true,
      code,
      retired: Boolean(retired),
      commitOutput,
      gitHash,
      configSummary: summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.get('/api/admin/promotion-history', (req, res) => {
  try {
    ensureRepo();
    const code = String(req.query.code || '').trim();

    if (!code) {
      return res.status(400).json({ ok: false, message: 'Promotion code is required.' });
    }

    const fileName = `${code.toLowerCase()}.json`;
    const filePath = path.join(promoDirectory, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: `Promotion ${code} was not found.` });
    }

    const history = getPromotionHistory(fileName);

    return res.json({
      ok: true,
      code,
      history,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/restore-promotion', (req, res) => {
  try {
    ensureRepo();
    const { code, commitHash } = req.body || {};

    if (!code || !commitHash) {
      return res.status(400).json({ ok: false, message: 'Promotion code and commit hash are required.' });
    }

    const fileName = `${String(code).toLowerCase()}.json`;
    const filePath = path.join(promoDirectory, fileName);
    const relativePath = `data/promotions/${fileName}`;

    const content = runGitCommand(['show', `${commitHash}:${relativePath}`], { allowFailure: true });
    if (!content) {
      return res.status(404).json({ ok: false, message: `Commit ${commitHash} does not contain a valid snapshot for ${code}.` });
    }

    const currentText = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
    const currentJson = parseJsonSafely(currentText);
    const targetJson = parseJsonSafely(content);

    if ((currentJson && targetJson && valuesAreEqual(currentJson, targetJson)) || (currentText.trim() && currentText.trim() === content.trim())) {
      return res.status(409).json({
        ok: false,
        message: `Promotion ${code} is already at commit ${commitHash}.`,
      });
    }

    fs.writeFileSync(filePath, content);
    runGitCommand(['add', relativePath]);
    const commitMessage = `Restore promotion ${code} from ${commitHash}`;
    const commitOutput = runGitCommand(['commit', '-m', commitMessage, '--only', '--', relativePath]);

    const summary = loadConfigurationsIntoMemory();
    const gitHash = getGitShortHash();

    return res.json({
      ok: true,
      code,
      restoredCommit: commitHash,
      commitOutput,
      gitHash,
      configSummary: summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/admin/restore-field', (req, res) => {
  try {
    ensureRepo();
    const { code, fieldPath, value } = req.body || {};

    if (!code || !fieldPath) {
      return res.status(400).json({ ok: false, message: 'Promotion code and field path are required.' });
    }

    const originalCode = String(code);
    const fileName = `${originalCode.toLowerCase()}.json`;
    const filePath = path.join(promoDirectory, fileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ ok: false, message: `Promotion ${originalCode} was not found.` });
    }

    const promotion = readJsonFile(filePath);
    const nextValue = parseFieldValue(value, fieldPath);
    const oldCode = String(promotion.code || originalCode);

    if (fieldPath === 'code') {
      const updatedCode = String(nextValue || oldCode).trim();
      if (updatedCode === oldCode) {
        return res.status(409).json({
          ok: false,
          message: `No change detected for ${fieldPath}; value is already ${updatedCode}.`,
        });
      }

      promotion.code = updatedCode;

      const oldFilePath = filePath;
      const newFileName = `${updatedCode.toLowerCase()}.json`;
      const newFilePath = path.join(promoDirectory, newFileName);

      fs.writeFileSync(newFilePath, JSON.stringify(promotion, null, 2));
      if (oldFilePath !== newFilePath && fs.existsSync(oldFilePath)) {
        fs.unlinkSync(oldFilePath);
      }

      runGitCommand(['add', '-A', '--', `data/promotions/${fileName}`, `data/promotions/${newFileName}`]);
      const commitMessage = `Restore code for ${oldCode}`;
      const commitOutput = runGitCommand(['commit', '-m', commitMessage]);

      const summary = loadConfigurationsIntoMemory();
      const gitHash = getGitShortHash();

      return res.json({
        ok: true,
        code: updatedCode,
        fieldPath,
        value: updatedCode,
        commitOutput,
        gitHash,
        configSummary: summary,
      });
    }

    const currentValue = getValueByPath(promotion, fieldPath);
    if (valuesAreEqual(currentValue, nextValue)) {
      return res.status(409).json({
        ok: false,
        message: `No change detected for ${fieldPath}; it is already ${JSON.stringify(nextValue)}.`,
      });
    }

    setValueByPath(promotion, fieldPath, nextValue);
    promotion.code = String(promotion.code || originalCode);

    fs.writeFileSync(filePath, JSON.stringify(promotion, null, 2));
    runGitCommand(['add', `data/promotions/${fileName}`]);

    const commitMessage = `Restore ${fieldPath} for ${originalCode}`;
    const commitOutput = runGitCommand(['commit', '-m', commitMessage]);

    const summary = loadConfigurationsIntoMemory();
    const gitHash = getGitShortHash();

    return res.json({
      ok: true,
      code: originalCode,
      fieldPath,
      value: nextValue,
      commitOutput,
      gitHash,
      configSummary: summary,
    });
  } catch (error) {
    return res.status(500).json({ ok: false, message: error.message });
  }
});

app.post('/api/checkout/evaluate', (req, res) => {
  const start = process.hrtime();

  try {
    const payload = req.body || {};
    const rawItems = Array.isArray(payload.items) ? payload.items : [];
    const promoCode = String(payload.promoCode || '').trim();

    if (!rawItems.length) {
      return res.status(400).json({ ok: false, message: 'At least one cart item is required.' });
    }

    const evaluation = CheckoutService.evaluate({
      rawItems,
      promoCode,
      pricingBySku: state.pricingBySku,
      promotions: state.promotions,
    });
    const elapsed = process.hrtime(start);
    const executionMs = Number((elapsed[0] * 1000 + elapsed[1] / 1e6).toFixed(3));

    return res.json({
      ok: true,
      executionTimeMs: executionMs,
      promoCode: promoCode || null,
      subtotal: evaluation.subtotal,
      discountAmount: evaluation.savings,
      grandTotal: evaluation.grandTotal,
      details: evaluation,
    });
  } catch (error) {
    const elapsed = process.hrtime(start);
    const executionMs = Number((elapsed[0] * 1000 + elapsed[1] / 1e6).toFixed(3));

    return res.status(400).json({
      ok: false,
      executionTimeMs: executionMs,
      message: error.message,
    });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(rootDir, 'index.html'));
});

ensureRepo();
ensureDataDirectories();
loadConfigurationsIntoMemory();

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Stateless commerce service listening on http://localhost:${PORT}`);
});
