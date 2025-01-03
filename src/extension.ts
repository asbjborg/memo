import * as vscode from 'vscode';
import MarkdownIt from 'markdown-it';

import { fileWatcher, cache } from './workspace';
import {
  referenceContextWatcher,
  completionProvider,
  DocumentLinkProvider,
  ReferenceHoverProvider,
  ReferenceProvider,
  ReferenceRenameProvider,
  BacklinksTreeDataProvider,
  extendMarkdownIt,
  newVersionNotifier,
  codeActionProvider,
} from './features';
import commands from './commands';
import logger from './logger';
import { getMemoConfigProperty, MemoBoolConfigProp, isDefined } from './utils';

const mdLangSelector = { language: 'markdown', scheme: '*' };

const when = <R>(configKey: MemoBoolConfigProp, cb: () => R): undefined | R =>
  getMemoConfigProperty(configKey, true) ? cb() : undefined;

export const activate = async (
  context: vscode.ExtensionContext,
): Promise<void | { extendMarkdownIt: typeof extendMarkdownIt }> => {
  newVersionNotifier.activate(context);

  if (process.env.DISABLE_FILE_WATCHER !== 'true') {
    fileWatcher.activate(context);
  }

  when('links.completion.enabled', () => completionProvider.activate(context));

  referenceContextWatcher.activate(context);

  await cache.cacheWorkspace();

  context.subscriptions.push(logger.logger);

  context.subscriptions.push(
    ...commands,
    vscode.languages.registerCodeActionsProvider(mdLangSelector, codeActionProvider),
    vscode.workspace.onDidChangeConfiguration(async (configChangeEvent) => {
      if (configChangeEvent.affectsConfiguration('search.exclude')) {
        await cache.cacheWorkspace();
      }
    }),
    ...[
      when('links.following.enabled', () =>
        vscode.languages.registerDocumentLinkProvider(mdLangSelector, new DocumentLinkProvider()),
      ),
      when('links.preview.enabled', () => {
        logger.info('Registering hover provider...');
        return vscode.languages.registerHoverProvider(mdLangSelector, new ReferenceHoverProvider());
      }),
      when('links.references.enabled', () =>
        vscode.languages.registerReferenceProvider(mdLangSelector, new ReferenceProvider()),
      ),
      when('links.sync.enabled', () =>
        vscode.languages.registerRenameProvider(mdLangSelector, new ReferenceRenameProvider()),
      ),
    ].filter(isDefined),
  );

  vscode.commands.executeCommand(
    'setContext',
    'memo:backlinksPanel.enabled',
    getMemoConfigProperty('backlinksPanel.enabled', true),
  );

  when('backlinksPanel.enabled', () => {
    const backlinksTreeDataProvider = new BacklinksTreeDataProvider();

    vscode.window.onDidChangeActiveTextEditor(
      async () => await backlinksTreeDataProvider.refresh(),
    );
    context.subscriptions.push(
      vscode.window.createTreeView('memo.backlinksPanel', {
        treeDataProvider: backlinksTreeDataProvider,
        showCollapseAll: true,
      }),
    );
  });

  logger.info('Memo extension successfully initialized! 🎉');

  // Return the markdown-it plugin if markdown preview is enabled
  return when('markdownPreview.enabled', () => ({
    extendMarkdownIt,
  }));
};

export function deactivate() {}
