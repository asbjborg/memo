import * as vscode from 'vscode';
import fs from 'fs';
import path from 'path';

import { cache } from '../workspace';
import {
  containsImageExt,
  containsUnknownExt,
  containsOtherKnownExts,
  getMemoConfigProperty,
  getReferenceAtPosition,
  isUncPath,
  findUriByRef,
  commonExtsHint,
  parseRef,
} from '../utils';

const outputChannel = vscode.window.createOutputChannel('Memo');

const findSectionContent = (content: string, targetSection: string): string | null => {
  outputChannel.appendLine(`DEBUG findSectionContent input: ${targetSection}`);

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

  outputChannel.appendLine(`DEBUG found sections: ${JSON.stringify(sections)}`);

  // Find matching section with duplicate handling
  let targetIndex = -1;
  let duplicateCount = 0;

  // Normalize target section once
  const normalizedTarget = targetSection
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
  outputChannel.appendLine(`DEBUG normalized target: ${normalizedTarget}`);

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const normalizedTitle = section.title
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');

    outputChannel.appendLine(
      `DEBUG comparing sections: ${JSON.stringify({
        title: section.title,
        normalizedTitle,
        targetSection,
        normalizedTarget,
        matches: normalizedTitle === normalizedTarget,
      })}`,
    );

    if (normalizedTitle === normalizedTarget) {
      if (duplicateCount === 0) {
        targetIndex = section.index;
      }
      duplicateCount++;
    }
  }

  if (targetIndex === -1) {
    outputChannel.appendLine('DEBUG section not found');
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

  const result = lines.slice(targetIndex, endIndex).join('\n');
  outputChannel.appendLine(
    `DEBUG section content: ${JSON.stringify({
      startLine: targetIndex,
      endLine: endIndex,
      contentPreview: result.slice(0, 100),
    })}`,
  );

  return result;
};

export default class ReferenceHoverProvider implements vscode.HoverProvider {
  public provideHover(document: vscode.TextDocument, position: vscode.Position) {
    outputChannel.appendLine('DEBUG provideHover called');
    const refAtPos = getReferenceAtPosition(document, position);
    outputChannel.appendLine(`DEBUG getReferenceAtPosition result: ${JSON.stringify(refAtPos)}`);

    if (refAtPos) {
      const { ref, range, section } = refAtPos;
      outputChannel.appendLine(`DEBUG found reference: ${JSON.stringify({ ref, range, section })}`);

      // Parse ref once at the start
      const { ref: filenameRef, label } = parseRef(ref);
      outputChannel.appendLine(
        `DEBUG parseRef details: ${JSON.stringify({
          filenameRef,
          label,
          section,
          originalRef: ref,
        })}`,
      );

      const hoverRange = new vscode.Range(
        new vscode.Position(range.start.line, range.start.character + 2),
        new vscode.Position(range.end.line, range.end.character - 2),
      );

      const uris = cache.getWorkspaceCache().allUris;
      const foundUri = findUriByRef(uris, filenameRef);

      if (!foundUri && containsUnknownExt(filenameRef)) {
        return new vscode.Hover(
          `Link contains unknown extension: ${
            path.parse(filenameRef).ext
          }. Please use common file extensions ${commonExtsHint} to enable full support.`,
          hoverRange,
        );
      }

      if (foundUri && fs.existsSync(foundUri.fsPath)) {
        const imageMaxHeight = Math.max(
          getMemoConfigProperty('links.preview.imageMaxHeight', 200),
          10,
        );
        const getContent = () => {
          if (containsImageExt(foundUri.fsPath)) {
            if (isUncPath(foundUri.fsPath)) {
              return new vscode.MarkdownString(
                'UNC paths are not supported for images preview due to VSCode Content Security Policy. Use markdown preview or open image via cmd (ctrl) + click instead.',
              );
            }

            return new vscode.MarkdownString(
              `![](${vscode.Uri.file(foundUri.fsPath).toString()}|height=${imageMaxHeight})`,
            );
          } else if (containsOtherKnownExts(foundUri.fsPath)) {
            const ext = path.parse(foundUri.fsPath).ext;
            return new vscode.MarkdownString(
              `Preview is not supported for "${ext}" file type. Click to open in the default app.`,
            );
          }

          const content = fs.readFileSync(foundUri.fsPath).toString();

          outputChannel.appendLine(`DEBUG section from initial parse: ${section}`);

          if (section) {
            outputChannel.appendLine(`DEBUG about to find section content for: ${section}`);
            outputChannel.appendLine(`DEBUG file content preview: ${content.slice(0, 200)}`);
            const sectionContent = findSectionContent(content, section);
            outputChannel.appendLine(
              `DEBUG findSectionContent result: ${JSON.stringify({
                section,
                found: sectionContent !== null,
                contentPreview: sectionContent?.slice(0, 100),
              })}`,
            );

            if (sectionContent !== null) {
              outputChannel.appendLine('DEBUG returning section content');
              const markdownContent = new vscode.MarkdownString();
              markdownContent.supportHtml = true;
              markdownContent.appendMarkdown(sectionContent);
              return markdownContent;
            }
            outputChannel.appendLine('DEBUG section not found, returning error message');
            return new vscode.MarkdownString(`Section "${section}" not found in ${filenameRef}`);
          }

          outputChannel.appendLine('DEBUG no section specified, returning full content');
          const markdownContent = new vscode.MarkdownString();
          markdownContent.supportHtml = true;
          markdownContent.appendMarkdown(content);
          return markdownContent;
        };

        return new vscode.Hover(getContent(), hoverRange);
      }

      return new vscode.Hover(`"${filenameRef}" is not created yet. Click to create.`, hoverRange);
    }

    return null;
  }
}
