'use strict';
// A small XML reader for S3 and STS responses. No DTDs, no entities beyond the 5 standard ones and character
// references, so a hostile response cannot expand. Returns { name, attrs, children, text } nodes.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return String.fromCodePoint(cp); } catch (err) { return ''; }
    }
    return ENT[e];
  });
}

function escapeXml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}

function parse(xml) {
  const text = String(xml);
  if (text.length > 64 * 1024 * 1024) throw new Error('XML response too large');
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { stack[stack.length - 1].text += decodeEntities(text.slice(i)); break; }
    if (lt > i) stack[stack.length - 1].text += decodeEntities(text.slice(i, lt));
    if (text.startsWith('<?', lt)) { const e = text.indexOf('?>', lt); i = e < 0 ? text.length : e + 2; continue; }
    if (text.startsWith('<!--', lt)) { const e = text.indexOf('-->', lt); i = e < 0 ? text.length : e + 3; continue; }
    if (text.startsWith('<![CDATA[', lt)) { const e = text.indexOf(']]>', lt); stack[stack.length - 1].text += text.slice(lt + 9, e < 0 ? text.length : e); i = e < 0 ? text.length : e + 3; continue; }
    if (text.startsWith('<!', lt)) throw new Error('XML with a DOCTYPE is not accepted');
    const gt = text.indexOf('>', lt);
    if (gt < 0) throw new Error('Broken XML');
    const tag = text.slice(lt + 1, gt);
    i = gt + 1;
    if (tag[0] === '/') {
      const name = tag.slice(1).trim().replace(/^[^:]+:/, '');
      if (stack.length > 1 && stack[stack.length - 1].name === name) stack.pop();
      else throw new Error('Broken XML: unexpected </' + name + '>');
      continue;
    }
    const self = tag.endsWith('/');
    const body = self ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body.trim());
    if (!m) throw new Error('Broken XML');
    const node = { name: m[1].replace(/^[^:]+:/, ''), attrs: {}, children: [], text: '' };
    m[2].replace(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (all, k, v, a, b) => { node.attrs[k] = decodeEntities(a !== undefined ? a : b); return ''; });
    stack[stack.length - 1].children.push(node);
    if (!self) {
      if (stack.length > 64) throw new Error('XML nested too deep');
      stack.push(node);
    }
  }
  if (stack.length !== 1) throw new Error('Broken XML: unclosed elements');
  return root.children[0] || root;
}

const child = (node, name) => (node && node.children.find((c) => c.name === name)) || null;
const children = (node, name) => (node ? node.children.filter((c) => c.name === name) : []);
const textOf = (node, name, dflt = '') => { const c = child(node, name); return c ? c.text : dflt; };

module.exports = { parse, child, children, textOf, escapeXml, decodeEntities };
