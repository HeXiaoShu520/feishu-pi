#!/usr/bin/env node
/**
 * 自动修补 @earendil-works/pi-ai 的 anthropic-messages.js
 * 删除导致中转站 403 的请求头：anthropic-dangerous-direct-browser-access
 *
 * 适用于任何版本，升级后自动应用
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const targetFile = join(__dirname, '../node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js');

try {
  let content = readFileSync(targetFile, 'utf-8');

  // 删除所有 "anthropic-dangerous-direct-browser-access": "true", 出现
  const originalContent = content;
  content = content.replace(/"anthropic-dangerous-direct-browser-access":\s*"true",?\s*/g, '');

  if (content !== originalContent) {
    writeFileSync(targetFile, content, 'utf-8');
    console.log('✅ [patch-pi-ai] 已删除 anthropic-dangerous-direct-browser-access 请求头');
  } else {
    console.log('ℹ️  [patch-pi-ai] 未发现需要修补的请求头（可能已被修补或版本已修复）');
  }
} catch (error) {
  console.error('❌ [patch-pi-ai] 修补失败:', error.message);
  process.exit(1);
}
