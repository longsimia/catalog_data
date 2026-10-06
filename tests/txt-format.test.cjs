'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const format = require('../src/txt-format');

test('renders exactly the six supported TXT formats', () => {
  const html = format.render('**粗體** *斜體* __底線__ ~~刪除線~~ [連結](https://example.com)\n> 引用');
  for (const tag of ['strong', 'em', 'u', 's', 'a', 'blockquote']) assert.match(html, new RegExp('<' + tag + '\\b'));
  assert.equal(format.parse('**粗體** *斜體* __底線__ ~~刪除線~~ [連結](https://example.com)\n> 引用').text, '粗體 斜體 底線 刪除線 連結\n引用');
  assert.match(format.render('# 標題\n---\n||文字||'), /# 標題\n---\n\|\|文字\|\|/);
});

test('handles nested styles, Unicode and balanced link URLs', () => {
  const text = '__***中文😀***__ [**標題**](https://example.com/a_(b))';
  assert.equal(format.parse(text).text, '中文😀 標題');
  const html = format.render(text);
  assert.match(html, /<u><strong><em>中文😀<\/em><\/strong><\/u>/);
  assert.match(html, /href="https:\/\/example.com\/a_\(b\)"/);
  assert.match(format.render('**粗體 *斜體* 結尾**'), /<strong>粗體 <em>斜體<\/em> 結尾<\/strong>/);
  assert.match(format.render('*斜體 **粗體***'), /<em>斜體 <strong>粗體<\/strong><\/em>/);
});

test('leaves incomplete markers, HTML and dangerous links as text', () => {
  const text = '**未完成 <script>alert(1)</script> [x](javascript:alert(1))';
  const html = format.render(text);
  assert.equal(format.parse(text).text, text);
  assert(!html.includes('<script>'));
  assert(!html.includes('<a '));
  assert.equal(format.safeUrl('java\nscript:alert(1)'), '');
  assert.equal(format.safeUrl('data:text/html,foo'), '');
  assert.equal(format.safeUrl('example.com/path', true), 'https://example.com/path');
});

test('preserves literal escapes, blank lines and paragraph indentation', () => {
  const text = '　　\\*星號\\*\n\n\n下一段';
  assert.equal(format.parse(text).text, '　　*星號*\n\n\n下一段');
  assert.match(format.render(text), /　　\*星號\*\n\n\n下一段/);
  assert.equal(format.parse('C:\\TRPG\\資料').text, 'C:\\TRPG\\資料');
});

test('maps visible selections across hidden syntax and URLs to source', () => {
  const model = format.parse('甲**粗體**[連結](https://example.com)乙');
  assert.equal(model.text, '甲粗體連結乙');
  const range = format.sourceRange(model, 1, 5);
  assert.equal(format.visibleAt(model, range.from), 1);
  assert.equal(format.visibleAt(model, range.to), 5);
  assert.equal(format.sourceAt(model, 0), 0);
});

test('toggles nested formats without changing displayed text', () => {
  let result = format.formatSelection('選取這句話，測試。', 0, 5, 'bold');
  for (const mark of ['italic', 'underline', 'strike']) result = format.formatSelection(result.text, result.from, result.to, mark);
  assert.equal(format.parse(result.text).text, '選取這句話，測試。');
  for (const tag of ['strong', 'em', 'u', 's']) assert.match(format.render(result.text), new RegExp('<' + tag + '>'));
  result = format.formatSelection(result.text, result.from, result.to, 'bold');
  assert(!format.render(result.text).includes('<strong>'));
  assert.match(format.render(result.text), /<em>/);
});

test('removes bold only within a partial selection', () => {
  const model = format.parse('**abcdef**');
  const range = format.sourceRange(model, 2, 4);
  const result = format.formatSelection(model.source, range.from, range.to, 'bold');
  assert.equal(format.parse(result.text).text, 'abcdef');
  assert.match(format.render(result.text), /<strong>ab<\/strong>cd<strong>ef<\/strong>/);
});

test('formats a multiline selection without losing newlines', () => {
  const original = '第一行\n第二行\n\n最後一行';
  const result = format.formatSelection(original, 0, 7, 'bold');
  assert.equal(format.parse(result.text).text, original);
  assert.equal((format.render(result.text).match(/<strong>/g) || []).length, 2);
});

test('quotes and unquotes complete paragraphs while preserving styles', () => {
  const original = '第一行\n**第二行**\n\n下一段';
  const quoted = format.quoteSelection(original, 1, 3);
  assert.equal(quoted.text, '> 第一行\n> **第二行**\n\n下一段');
  assert.equal(format.parse(quoted.text).text, format.parse(original).text);
  const unquoted = format.quoteSelection(quoted.text, quoted.from, quoted.to);
  assert.equal(unquoted.text, original);
});

test('replaces visible text across styles while retaining unaffected text', () => {
  const result = format.replaceVisible('**Hello** __world__\n\n下一段', 1, 9, '甲乙');
  assert.equal(format.parse(result.text).text, 'H甲乙ld\n\n下一段');
  assert.match(format.render(result.text), /<strong>/);
  assert.match(format.render(result.text), /<u>ld<\/u>/);
});

test('text conversion keeps syntax and link destinations intact', () => {
  const original = '**半形!** [說明!](https://example.com/a!)\n> 引用!';
  const result = format.transformText(original, text => text.replace(/!/g, '！'));
  assert.equal(format.parse(result).text, '半形！ 說明！\n引用！');
  assert.equal(format.parse(result).links[0].href, 'https://example.com/a!');
  assert.match(result, /^\*\*半形！\*\*/);
});

test('indent and blank-line tools respect quote prefixes and existing styles', () => {
  assert.equal(format.indent('> **內容**', true), '> 　　**內容**');
  assert.equal(format.parse(format.indent('> **　　內容**', false)).text, '內容');
  assert.equal(format.blankLines('> 第一行\n> 第二行', true), '> 第一行\n> \n> 第二行');
  assert.equal(format.blankLines('> 第一行\n> \n\n> 第二行', false), '> 第一行\n> 第二行');
});

test('a caret on an empty quote line maps after the hidden prefix', () => {
  const model = format.parse('> 引用\n> ');
  assert.equal(format.sourceAt(model, model.text.length), model.source.length);
  assert.equal(format.parse('> **　　**').text, '　　');
  assert.match(format.render('> **　　**'), /<strong>　　<\/strong>/);
});

test('splitting styled text into lines keeps both styles and quote prefixes', () => {
  const result = format.replaceVisible('> **引用內容**', 2, 2, '\n');
  assert.equal(result.text, '> **引用**\n> **內容**');
  assert.equal(format.parse(result.text).text, '引用\n內容');
  assert.equal(format.parse(result.text).lines.length, 2);
});

test('Chinese/English spacing spans style boundaries and protects link URLs', () => {
  for (const source of ['中文**English**中文', '**中文**English中文', '中文***English***中文', '中文[English](https://example.com/中文)中文']) {
    const result = format.addCjkSpacing(source);
    assert.equal(format.parse(result).text, '中文 English 中文');
    assert.equal(format.addCjkSpacing(result), result);
    if (format.parse(source).links.length) assert.equal(format.parse(result).links[0].href, format.parse(source).links[0].href);
  }
  assert.equal(format.addCjkSpacing('中文**English**'), '中文 **English**');
  assert.equal(format.addCjkSpacing('**中文**English'), '**中文** English');
});
