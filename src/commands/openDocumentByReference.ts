import vscode from 'vscode';
import fs from 'fs';
import path from 'path';

import { cache } from '../workspace';
import {
  findUriByRef,
  ensureDirectoryExists,
  parseRef,
  getWorkspaceFolder,
  getRefWithExt,
  resolveShortRefFolder,
} from '../utils';

let workspaceErrorShown = false;

const findSectionPosition = async (
  document: vscode.TextDocument,
  section: string,
): Promise<vscode.Position | undefined> => {
  const text = document.getText();
  const lines = text.split('\n');
  const headerRegex = /^(#{1,6})\s*(.+?)\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(headerRegex);
    if (match) {
      const title = match[2];
      const normalizedTitle = title
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');
      const normalizedSection = section
        .toLowerCase()
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-');

      if (normalizedTitle === normalizedSection) {
        return new vscode.Position(i, 0);
      }
    }
  }
  return undefined;
};

const openDocumentByReference = async ({
  reference,
  showOption = vscode.ViewColumn.Active,
  section,
}: {
  reference: string;
  showOption?: vscode.ViewColumn;
  section?: string;
}) => {
  const { ref } = parseRef(reference);

  const uri = findUriByRef(cache.getWorkspaceCache().allUris, ref);

  if (uri) {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document, showOption);

    if (section) {
      const decodedSection = decodeURIComponent(section);
      const position = await findSectionPosition(document, decodedSection);
      if (position) {
        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.AtTop);
      }
    }
  } else {
    const workspaceFolder = getWorkspaceFolder()!;
    if (workspaceFolder) {
      const refWithExt = getRefWithExt(ref);
      const shortRefFolder = resolveShortRefFolder(ref);

      const filePath = path.join(
        workspaceFolder,
        ...(shortRefFolder ? [shortRefFolder, refWithExt] : [refWithExt]),
      );

      // don't override file content if it already exists
      if (!fs.existsSync(filePath)) {
        ensureDirectoryExists(filePath);
        fs.writeFileSync(filePath, '');
      }

      await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(filePath), showOption);
    } else if (!workspaceErrorShown) {
      workspaceErrorShown = true;

      vscode.window.showErrorMessage(
        `It seems that you are trying to use Memo in single file mode.

        Memo works best in folder/workspace mode.

        The easiest way to start is to create a new folder and drag it onto the VSCode or use File > Open Folder... from the menu bar.
        `,
      );
    }
  }
};

export default openDocumentByReference;
