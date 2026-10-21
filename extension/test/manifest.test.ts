import { describe, expect, it } from 'vitest';
import { VERIFY_ENDPOINTS } from '@sfe/contract';
import { ICON_SIZES, buildManifest, extensionPagesCsp } from '../src/manifest';
import { adler32, crc32, encodePng, iconPng, renderRoundedSquare, storedDeflate } from '../build/png';

const manifest = buildManifest() as Record<string, any>;

describe('manifest', () => {
  it('is MV3 with the product name', () => {
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.name).toBe('Safari 场景出口');
  });

  it('requests only nativeMessaging and storage (no tabs)', () => {
    expect(manifest.permissions).toEqual(['nativeMessaging', 'storage']);
    expect(JSON.stringify(manifest)).not.toContain('"tabs"');
    expect(manifest.optional_permissions).toBeUndefined();
  });

  it('host permissions are the Amazon site plus every verify endpoint host, nothing broader', () => {
    const expected = ['https://www.amazon.com/*', ...VERIFY_ENDPOINTS.map((e) => `https://${e.host}/*`)];
    expect(manifest.host_permissions).toEqual(expected);
    for (const p of manifest.host_permissions as string[]) {
      expect(p).not.toContain('<all_urls>');
      expect(p).not.toMatch(/^\*:|:\/\/\*/);
    }
  });

  it('uses a non-persistent module background', () => {
    expect(manifest.background).toEqual({ scripts: ['background.js'], type: 'module', persistent: false });
  });

  it('injects the content script only on sign-in paths, top frame only, at document_idle', () => {
    expect(manifest.content_scripts).toEqual([
      {
        matches: ['https://www.amazon.com/ap/*', 'https://www.amazon.com/ax/*'],
        js: ['content.js'],
        run_at: 'document_idle',
        all_frames: false,
      },
    ]);
  });

  it('declares the popup and icons', () => {
    expect(manifest.action.default_popup).toBe('popup.html');
    for (const s of ICON_SIZES) expect(manifest.icons[String(s)]).toBe(`icons/icon-${s}.png`);
  });

  it('restricts extension pages to their own scripts and the verify endpoints', () => {
    const csp = extensionPagesCsp();
    expect(manifest.content_security_policy.extension_pages).toBe(csp);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(csp).toContain('connect-src');
    for (const e of VERIFY_ENDPOINTS) expect(csp).toContain(`https://${e.host}`);
    expect(csp).not.toContain('amazon.com');
  });
});

describe('placeholder icon PNG', () => {
  it('computes the standard CRC-32 and Adler-32 check values', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes)).toBe(0xcbf43926);
    expect(adler32(bytes)).toBe(0x091e01de);
  });

  it('stored deflate round-trips through a standard zlib decoder, including multi-block input', async () => {
    const data = new Uint8Array(150000).map((_, i) => i % 251);
    const stream = new Response(storedDeflate(data) as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('deflate'));
    const out = new Uint8Array(await new Response(stream).arrayBuffer());
    expect(out.length).toBe(data.length);
    expect(out.every((v, i) => v === data[i])).toBe(true);
  });

  it('encodes a valid RGBA PNG of the requested size', () => {
    const png = iconPng(16);
    expect(Array.from(png.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer, png.byteOffset);
    expect(String.fromCharCode(...png.slice(12, 16))).toBe('IHDR');
    expect(view.getUint32(16)).toBe(16);
    expect(view.getUint32(20)).toBe(16);
    expect(png[24]).toBe(8);
    expect(png[25]).toBe(6);
    expect(view.getUint32(29)).toBe(crc32(png.slice(12, 29)));
    expect(String.fromCharCode(...png.slice(-8, -4))).toBe('IEND');
  });

  it('draws a teal rounded square with transparent corners', () => {
    const size = 64;
    const px = renderRoundedSquare(size);
    const at = (x: number, y: number) => Array.from(px.slice((y * size + x) * 4, (y * size + x) * 4 + 4));
    expect(at(0, 0)[3]).toBe(0);
    expect(at(size - 1, size - 1)[3]).toBe(0);
    const center = at(32, 32);
    expect(center[3]).toBe(255);
    expect(center[1]!).toBeGreaterThan(center[0]!);
    expect(center[1]!).toBeGreaterThan(center[2]!);
  });

  it('rejects a mismatched pixel buffer', () => {
    expect(() => encodePng(2, 2, new Uint8Array(3))).toThrow();
  });
});
