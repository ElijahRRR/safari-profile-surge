import { describe, expect, test } from 'vitest';
import { XmlError, attrByLocal, decodeXmlEntities, localName, parseXmlTree, xmlEvents, type XmlEvent } from '../../src/importer/xml.js';

const events = (xml: string): XmlEvent[] => [...xmlEvents(xml)];

function xmlError(fn: () => unknown): XmlError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(XmlError);
    return e as XmlError;
  }
  throw new Error('expected XmlError');
}

describe('xmlEvents', () => {
  test('elements, attributes and text', () => {
    expect(events('<a x="1" y=\'2\'>hi<b/></a>')).toEqual([
      { type: 'open', name: 'a', attrs: { x: '1', y: '2' }, selfClosing: false },
      { type: 'text', text: 'hi' },
      { type: 'open', name: 'b', attrs: {}, selfClosing: true },
      { type: 'close', name: 'b' },
      { type: 'close', name: 'a' },
    ]);
  });

  test('declaration, processing instructions and comments are skipped', () => {
    const ev = events('<?xml version="1.0"?>\n<!-- c --><a><?pi x?><!-- inner --></a>');
    expect(ev.map((e) => e.type)).toEqual(['open', 'close']);
  });

  test('CDATA is returned verbatim', () => {
    expect(events('<a><![CDATA[<b>&amp;</b>]]></a>')[1]).toEqual({ type: 'text', text: '<b>&amp;</b>' });
  });

  test('predefined entities and numeric references are decoded', () => {
    expect(events('<a t="&lt;&quot;&apos;">&amp;&gt;&#65;&#x4E2D;</a>')).toEqual([
      { type: 'open', name: 'a', attrs: { t: '<"\'' }, selfClosing: false },
      { type: 'text', text: '&>A中' },
      { type: 'close', name: 'a' },
    ]);
  });

  test('prefixed names are kept; localName strips the prefix', () => {
    const ev = events('<x:row r:id="rId1"/>');
    expect(ev[0]).toMatchObject({ name: 'x:row' });
    expect(localName('x:row')).toBe('row');
    expect(attrByLocal({ 'r:id': 'rId1', id: 'plain' }, 'id', true)).toBe('rId1');
    expect(attrByLocal({ 'r:id': 'rId1', id: 'plain' }, 'id')).toBe('plain');
  });

  test('leading BOM is ignored', () => {
    expect(events('﻿<a/>')).toHaveLength(2);
  });
});

describe('xmlEvents rejects declarations and unknown entities', () => {
  test.each([
    '<!DOCTYPE a [<!ENTITY x "y">]><a>&x;</a>',
    '<?xml version="1.0"?><!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>',
    '<a><!ENTITY x "y"></a>',
    '<!ELEMENT a ANY><a/>',
  ])('%j → dtd', (xml) => {
    expect(xmlError(() => events(xml)).reason).toBe('dtd');
  });

  test('undeclared named entity → dtd', () => {
    expect(xmlError(() => events('<a>&nbsp;</a>')).reason).toBe('dtd');
    expect(xmlError(() => events('<a t="&x;"/>')).reason).toBe('dtd');
  });
});

describe('xmlEvents rejects malformed input', () => {
  test.each([
    ['mismatched tags', '<a></b>'],
    ['unclosed element', '<a><b></b>'],
    ['multiple roots', '<a/><b/>'],
    ['text outside root', 'x<a/>'],
    ['duplicate attribute', '<a x="1" x="2"/>'],
    ['unquoted attribute', '<a x=1/>'],
    ['missing whitespace between attributes', '<a x="1"y="2"/>'],
    ['lt in attribute', '<a x="<"/>'],
    ['bare ampersand', '<a>a & b</a>'],
    ['NUL char reference', '<a>&#0;</a>'],
    ['surrogate char reference', '<a>&#xD800;</a>'],
    ['out of range reference', '<a>&#x110000;</a>'],
    ['empty document', ''],
    ['unterminated comment', '<a><!-- x</a>'],
    ['unterminated CDATA', '<a><![CDATA[x</a>'],
    ['bad element name', '<1a/>'],
  ])('%s', (_label, xml) => {
    expect(xmlError(() => events(xml)).reason).toBe('malformed');
  });
});

describe('helpers', () => {
  test('decodeXmlEntities passes through plain text', () => {
    expect(decodeXmlEntities('plain')).toBe('plain');
  });

  test('parseXmlTree builds a tree with local names', () => {
    const t = parseXmlTree('<r:root xmlns:r="urn:x"><r:child a="1">t</r:child><other/></r:root>');
    expect(t.local).toBe('root');
    expect(t.children.map((c) => c.local)).toEqual(['child', 'other']);
    expect(t.children[0]!.text).toBe('t');
    expect(t.children[0]!.attrs['a']).toBe('1');
  });
});
