// tests/imports.test.mjs — transcript parsers (src/imports/parsers.js).
import test from 'node:test'
import assert from 'node:assert/strict'
import { detectFormat, parseJsonlTranscript, parseMarkdownTranscript, parseGenericText } from '../lib/imports/parsers.js'

test('detectFormat: extension wins', () => {
  assert.equal(detectFormat('chat.jsonl', '{}'), 'jsonl')
  assert.equal(detectFormat('chat.JSONL', ''), 'jsonl')
  assert.equal(detectFormat('chat.md', ''), 'markdown')
  assert.equal(detectFormat('chat.markdown', ''), 'markdown')
  assert.equal(detectFormat('chat.txt', ''), 'generic')
})

test('detectFormat: content sniffing without extension', () => {
  assert.equal(detectFormat('chat', '{"type":"user","message":{}}'), 'jsonl')
  assert.equal(detectFormat('chat', '## User\nhello'), 'markdown')
  assert.equal(detectFormat('chat', '**User:** hello'), 'markdown')
  assert.equal(detectFormat('chat', 'hello world'), 'generic')
  // 非 JSON 大括号开头不误判为 jsonl
  assert.equal(detectFormat('chat', '{not json'), 'generic')
})

test('parseJsonlTranscript: Claude Code style with block content', () => {
  const text = [
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    '{"type":"user","message":{"role":"user","content":[{"type":"text","text":"next"}]}}',
  ].join('\n')
  assert.deepEqual(parseJsonlTranscript(text), [
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'hi' },
    { role: 'user', text: 'next' },
  ])
})

test('parseJsonlTranscript: string content and Cursor-style rows', () => {
  const text = [
    '{"type":"user","message":{"role":"user","content":"plain string"}}',
    '{"role":"assistant","content":"cursor style"}',
  ].join('\n')
  assert.deepEqual(parseJsonlTranscript(text), [
    { role: 'user', text: 'plain string' },
    { role: 'assistant', text: 'cursor style' },
  ])
})

test('parseJsonlTranscript: skips system/tool lines and merges adjacent same-role turns', () => {
  const text = [
    '{"type":"system","message":{"role":"system","content":"be nice"}}',
    '{"type":"tool","name":"search"}',
    '{"type":"user","message":{"role":"user","content":"a"}}',
    '{"type":"user","message":{"role":"user","content":"b"}}',
    '{"type":"assistant","message":{"role":"assistant","content":"answer"}}',
    'not json',
    '',
  ].join('\n')
  assert.deepEqual(parseJsonlTranscript(text), [
    { role: 'user', text: 'a\nb' },
    { role: 'assistant', text: 'answer' },
  ])
})

test('parseJsonlTranscript: empty input and empty-content messages produce no turns', () => {
  assert.deepEqual(parseJsonlTranscript(''), [])
  assert.deepEqual(parseJsonlTranscript('{"type":"user","message":{"role":"user","content":[]}}'), [])
})

test('parseMarkdownTranscript: heading turns', () => {
  const text = [
    '# Chat',
    '## User',
    'hello there',
    'second line',
    '## Assistant',
    'hi!',
    '### User',
    'again',
  ].join('\n')
  assert.deepEqual(parseMarkdownTranscript(text), [
    { role: 'user', text: 'hello there\nsecond line' },
    { role: 'assistant', text: 'hi!' },
    { role: 'user', text: 'again' },
  ])
})

test('parseMarkdownTranscript: bold-prefix turns', () => {
  const text = '**User:** question\n**Assistant:** answer'
  assert.deepEqual(parseMarkdownTranscript(text), [
    { role: 'user', text: 'question' },
    { role: 'assistant', text: 'answer' },
  ])
})

test('parseGenericText: prefixed turns with multi-line bodies', () => {
  const text = 'User: first\nmore\nAssistant: reply\nUser: third'
  assert.deepEqual(parseGenericText(text), [
    { role: 'user', text: 'first\nmore' },
    { role: 'assistant', text: 'reply' },
    { role: 'user', text: 'third' },
  ])
})

test('parseGenericText: chinese prefixes and fallback', () => {
  assert.deepEqual(parseGenericText('用户：你好\n助手：你好呀'), [
    { role: 'user', text: '你好' },
    { role: 'assistant', text: '你好呀' },
  ])
  // 无标记 → 整体一条 user 消息
  assert.deepEqual(parseGenericText('just one message'), [{ role: 'user', text: 'just one message' }])
  assert.deepEqual(parseGenericText('   '), [])
})
