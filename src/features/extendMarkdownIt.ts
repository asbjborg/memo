import MarkdownIt from 'markdown-it';
import markdownItRegex from 'markdown-it-regex';
import path from 'path';
import fs from 'fs';

import { cache } from '../workspace';
import {
  getImgUrlForMarkdownPreview,
  getFileUrlForMarkdownPreview,
  containsImageExt,
  containsUnknownExt,
  findUriByRef,
  extractEmbedRefs,
  parseRef,
  commonExtsHint,
} from '../utils';

const getInvalidRefAnchor = (text: string) =>
  `<a class="memo-invalid-link" title="Link does not exist yet. Please use cmd / ctrl + click in text editor to create a new one." href="javascript:void(0)">${text}</a>`;

const getUnknownExtRefAnchor = (text: string, ref: string) =>
  `<a class="memo-invalid-link" title="Link contains unknown extension: ${
    path.parse(ref).ext
  }. Please use common file extensions ${commonExtsHint} to enable full support." href="javascript:void(0)">${text}</a>`;

const findSectionAnchor = (content: string, targetSection: string): string => {
  const lines = content.split('\n');
  const headerRegex = /^(#{1,6})\s*(.+?)\s*$/;
  const sections = new Map<string, number>();

  // First pass: collect all headers and handle duplicates
  lines.forEach((line) => {
    const match = line.match(headerRegex);
    if (match) {
      const title = match[2];
      const normalizedTitle = title
        .toLowerCase()
        .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
      sections.set(normalizedTitle, (sections.get(normalizedTitle) || 0) + 1);
    }
  });

  // Second pass: find the correct anchor
  const normalizedTarget = targetSection
    .toLowerCase()
    .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
  const count = sections.get(normalizedTarget) || 0;

  if (count > 1) {
    let currentCount = 0;
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(headerRegex);
      if (match) {
        const title = match[2];
        const normalizedTitle = title
          .toLowerCase()
          .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
          .replace(/[^\w\s-]/g, '')
          .replace(/\s+/g, '-');
        if (normalizedTitle === normalizedTarget) {
          currentCount++;
          if (currentCount > 1) {
            return `${normalizedTarget}-${currentCount - 1}`;
          }
        }
      }
    }
  }

  return normalizedTarget;
};

const findSectionContent = (content: string, targetSection: string): string | null => {
  const lines = content.split('\n');
  const headerRegex = /^(#{1,6})\s*(.+?)\s*$/;
  const sections: { level: number; title: string; index: number }[] = [];

  // First pass: collect all headers and handle duplicates
  lines.forEach((line, index) => {
    const match = line.match(headerRegex);
    if (match) {
      const level = match[1].length;
      const title = match[2];
      sections.push({ level, title, index });
    }
  });

  // Find matching section with duplicate handling
  let targetIndex = -1;
  let duplicateCount = 0;

  // Normalize target section once
  const normalizedTarget = targetSection
    .toLowerCase()
    .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const normalizedTitle = section.title
      .toLowerCase()
      .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');

    if (normalizedTitle === normalizedTarget) {
      if (duplicateCount === 0) {
        targetIndex = section.index;
      }
      duplicateCount++;
    }
  }

  if (targetIndex === -1) {
    return null;
  }

  // Find the end of the section
  let endIndex = lines.length;
  const targetLevel = sections.find((s) => s.index === targetIndex)!.level;

  for (let i = targetIndex + 1; i < lines.length; i++) {
    const match = lines[i].match(headerRegex);
    if (match && match[1].length <= targetLevel) {
      endIndex = i;
      break;
    }
  }

  return lines.slice(targetIndex, endIndex).join('\n');
};

const renderEmbeddedContent = (content: string, section?: string): string => {
  if (section) {
    const sectionContent = findSectionContent(content, section);
    if (sectionContent) {
      return sectionContent;
    }
  }
  return content;
};

const extendMarkdownIt = (md: MarkdownIt) => {
  // Add header ID generation
  const defaultRender =
    md.renderer.rules.heading_open ||
    ((tokens, idx, options, env, self) => self.renderToken(tokens, idx, options));

  md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const nextToken = tokens[idx + 1];

    if (nextToken && nextToken.type === 'inline') {
      const title = nextToken.content;
      const id = title
        .toLowerCase()
        .replace(/^\d+\.\s*/, '') // Remove any leading numbers like "1. "
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');

      token.attrSet('id', id);
    }

    return defaultRender(tokens, idx, options, env, self);
  };

  const refsStack: string[] = [];

  const mdExtended = md
    .use(markdownItRegex, {
      name: 'ref-resource',
      regex: /!\[\[([^\[\]]+?)\]\]/,
      replace: (rawRef: string) => {
        const { ref, label, section } = parseRef(rawRef);

        if (containsImageExt(ref)) {
          const imagePath = findUriByRef(cache.getWorkspaceCache().imageUris, ref)?.fsPath;

          if (imagePath) {
            return `<div><img src="${getImgUrlForMarkdownPreview(
              imagePath,
            )}" data-src="${getImgUrlForMarkdownPreview(imagePath)}" alt="${
              label || ref
            }" /></div>`;
          }
        }

        const fsPath = findUriByRef(cache.getWorkspaceCache().markdownUris, ref)?.fsPath;

        if (!fsPath && containsUnknownExt(ref)) {
          return getUnknownExtRefAnchor(label || ref, ref);
        }

        if (!fsPath || !fs.existsSync(fsPath)) {
          return getInvalidRefAnchor(label || ref);
        }

        const previewFileUrl = getFileUrlForMarkdownPreview(fsPath);
        const name = path.parse(fsPath).name;
        const content = fs.readFileSync(fsPath).toString();
        const refs = extractEmbedRefs(content).map((ref) => ref.toLowerCase());

        const cyclicLinkDetected =
          refs.includes(ref.toLowerCase()) || refs.some((ref) => refsStack.includes(ref));

        if (!cyclicLinkDetected) {
          refsStack.push(ref.toLowerCase());
        }

        const html = `<div class="memo-markdown-embed">
          <div class="memo-markdown-embed-title">${name}</div>
          <div class="memo-markdown-embed-link">
            <a title="${previewFileUrl}" href="${previewFileUrl}" data-href="${previewFileUrl}">
              <i class="icon-link"></i>
            </a>
          </div>
          <div class="memo-markdown-embed-content">
            ${
              !cyclicLinkDetected
                ? (mdExtended as any).render(
                    renderEmbeddedContent(content, section),
                    undefined,
                    true,
                  )
                : '<div class="memo-cyclic-link-warning">Cyclic linking detected 💥.</div>'
            }
          </div>
        </div>`;

        if (!cyclicLinkDetected) {
          refsStack.pop();
        }

        return html;
      },
    })
    .use(markdownItRegex, {
      name: 'ref-document',
      regex: /\[\[([^\[\]]+?)\]\]/,
      replace: (rawRef: string) => {
        const { ref, label, section } = parseRef(rawRef);
        const fsPath = findUriByRef(cache.getWorkspaceCache().allUris, ref)?.fsPath;

        if (!fsPath && containsUnknownExt(ref)) {
          return getUnknownExtRefAnchor(label || ref, ref);
        }

        if (!fsPath) {
          return getInvalidRefAnchor(label || ref);
        }

        const previewFileUrl = getFileUrlForMarkdownPreview(fsPath);
        const displayText = label || (section ? `${ref}#${section}` : ref);
        const content = fs.readFileSync(fsPath).toString();
        const anchor = section ? '#' + findSectionAnchor(content, section) : '';

        if (section) {
          return `<div class="memo-markdown-embed">
            <div class="memo-markdown-embed-title">${displayText}</div>
            <div class="memo-markdown-embed-link">
              <a title="${previewFileUrl}${anchor}" href="${previewFileUrl}${anchor}" data-href="${previewFileUrl}${anchor}">
                <i class="icon-link"></i>
              </a>
            </div>
            <div class="memo-markdown-embed-content">
              ${(mdExtended as any).render(
                renderEmbeddedContent(content, section),
                undefined,
                true,
              )}
            </div>
          </div>`;
        }

        return `<a title="${previewFileUrl}${anchor}" href="${previewFileUrl}${anchor}" data-href="${previewFileUrl}${anchor}">${displayText}</a>`;
      },
    });

  return mdExtended;
};

export default extendMarkdownIt;
