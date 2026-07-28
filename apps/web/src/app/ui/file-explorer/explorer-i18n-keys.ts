import type { TranslationKey } from '../../i18n/keys';

/**
 * Explorer translation keys — catalog entries are added by agent 04.
 * Keys fall back to themselves until catalogs are updated.
 */
export const EXPLORER_I18N = {
  title: 'explorer.title',
  ariaPanel: 'explorer.aria.panel',
  ariaTree: 'explorer.aria.tree',
  ariaViewSwitch: 'explorer.aria.viewSwitch',
  viewFiles: 'explorer.view.files',
  viewPipeline: 'explorer.view.pipeline',
  collapse: 'explorer.collapse',
  collapseAria: 'explorer.collapseAria',
  createMenu: 'explorer.createMenu',
  createBuffer: 'explorer.createBuffer',
  createFile: 'explorer.createFile',
  buffersFull: 'explorer.buffersFull',
  expandGroup: 'explorer.expandGroup',
  collapseGroup: 'explorer.collapseGroup',
  rowActions: 'explorer.rowActions',
  statusUnsaved: 'explorer.status.unsaved',
  statusCompiling: 'explorer.status.compiling',
  statusErrors: 'explorer.status.errors',
  statusDisabled: 'explorer.status.disabled',
  stateLoading: 'explorer.state.loading',
  stateNoProject: 'explorer.state.noProject',
  stateNoDocuments: 'explorer.state.noDocuments',
  commandRename: 'action.rename',
  commandDuplicate: 'action.duplicate',
  commandDelete: 'action.delete',
  commandEnable: 'explorer.command.enable',
  commandDisable: 'explorer.command.disable',
} as const;

export type ExplorerI18nKey = keyof typeof EXPLORER_I18N;

export function explorerTranslationKey(key: ExplorerI18nKey): TranslationKey {
  return EXPLORER_I18N[key] as TranslationKey;
}
