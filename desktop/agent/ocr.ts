/* ============================================================================
 * desktop/agent/ocr.ts —— 本机文字识别（Windows 自带引擎，离线、不需要 Key）
 *
 * 用 Windows.Media.Ocr（系统自带，中英文都能认）跑一遍图片里的文字：
 *   PowerShell 调 WinRT → 结果写 UTF-8 文件 → Node 读回来。
 * 不走网络、不装第三方库、不消耗任何 API。
 *
 * 只在 Windows 上有；其它平台直接返回 unsupported，由调用方降级。
 * OCR 对小字 / 复杂背景会认错，结果要标注「可能有错字」。
 * ==========================================================================*/

import { app } from 'electron';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export interface OcrResult {
  ok: boolean;
  /** 识别到的文字（按行拼接） */
  text: string;
  /** 行数，0 表示没认到字 */
  lines: number;
  /** 实际用的语言包 */
  lang?: string;
  error?: string;
}

/** WinRT 异步调用在 PowerShell 5.1 里必须手动 AsTask；结果写到 -Out 指定的 UTF-8 文件 */
const SCRIPT = `param([string]$Path, [string]$Out)
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Foundation, ContentType = WindowsRuntime]

  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]

  function Await($op, $type) {
    $task = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op))
    $task.Wait(20000) | Out-Null
    return $task.Result
  }

  $lines = New-Object System.Collections.Generic.List[string]
  $langUsed = ''
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($Path)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])

  $engine = $null
  foreach ($tag in @('zh-Hans-CN', 'zh-CN', 'en-US')) {
    $language = [Windows.Globalization.Language]::new($tag)
    $try = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($try) { $engine = $try; $langUsed = $tag; break }
  }
  if (-not $engine) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    $langUsed = 'profile'
  }
  if (-not $engine) { throw 'no OCR engine' }

  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $result.Lines) { if ($line.Text.Trim().Length -gt 0) { $lines.Add($line.Text.Trim()) } }

  $payload = @{ lang = $langUsed; lines = $lines.Count; text = ($lines -join "\`n") } | ConvertTo-Json -Compress
  [System.IO.File]::WriteAllText($Out, $payload, (New-Object System.Text.UTF8Encoding($false)))
} catch {
  $payload = @{ lang = ''; lines = 0; text = ''; error = $_.Exception.Message } | ConvertTo-Json -Compress
  try { [System.IO.File]::WriteAllText($Out, $payload, (New-Object System.Text.UTF8Encoding($false))) } catch { }
}
`;

let scriptPath: string | null = null;

function workDir(): string {
  const dir = path.join(app.getPath('temp'), 'naiwa-ocr');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureScript(): string {
  if (scriptPath && fs.existsSync(scriptPath)) return scriptPath;
  const file = path.join(workDir(), 'ocr.ps1');
  fs.writeFileSync(file, SCRIPT, 'utf8');
  scriptPath = file;
  return file;
}

function run(file: string, args: string[], timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${err.message}${stderr ? ` | ${String(stderr).slice(0, 200)}` : ''}`));
      else resolve(stdout);
    });
  });
}

/**
 * 识别一张本地图片里的文字。失败不抛异常，返回 ok:false + error，
 * 调用方（识图）会把「没认到字」当成正常结果继续往下走。
 */
export async function ocrImageFile(imagePath: string, maxChars = 1500): Promise<OcrResult> {
  if (process.platform !== 'win32') {
    return { ok: false, text: '', lines: 0, error: '本机 OCR 目前只在 Windows 上提供' };
  }
  // WinRT 的 StorageFile 只认反斜杠路径，这里统一一下
  imagePath = path.win32.normalize(imagePath);
  if (!imagePath || !fs.existsSync(imagePath)) {
    return { ok: false, text: '', lines: 0, error: '图片文件不存在' };
  }
  const out = path.join(workDir(), `ocr-${Date.now()}.json`);
  try {
    await run(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ensureScript(), '-Path', imagePath, '-Out', out],
      25_000,
    );
  } catch (err) {
    return { ok: false, text: '', lines: 0, error: `本机 OCR 调用失败：${(err as Error).message.slice(0, 200)}` };
  }

  try {
    const raw = await fsp.readFile(out, 'utf8');
    const parsed = JSON.parse(raw) as { lang?: string; lines?: number; text?: string; error?: string };
    await fsp.unlink(out).catch(() => {});
    if (parsed.error) return { ok: false, text: '', lines: 0, error: `本机 OCR 失败：${parsed.error}` };
    const text = (parsed.text ?? '').trim();
    return {
      ok: true,
      text: text.length > maxChars ? `${text.slice(0, maxChars)}…` : text,
      lines: Number(parsed.lines) || 0,
      lang: parsed.lang || undefined,
    };
  } catch (err) {
    return { ok: false, text: '', lines: 0, error: `本机 OCR 结果读不出来：${(err as Error).message.slice(0, 120)}` };
  }
}
