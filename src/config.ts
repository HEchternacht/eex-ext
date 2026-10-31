import * as vscode from 'vscode';
import type { CanvasSettings } from '../shared/protocol';

export function cfg() {
  const c = vscode.workspace.getConfiguration('codeflow');
  return {
    pythonPath: c.get<string>('pythonPath', ''),
    exclude: c.get<string[]>('exclude', []),
    ignoreLibraryConnections: c.get<boolean>('ignoreLibraryConnections', false),
    levelMode: c.get<'relative' | 'fixed'>('levelMode', 'relative'),
    nestSingleUse: c.get<boolean>('nestSingleUse', true),
    editorMode: c.get<'virtual' | 'file'>('editorMode', 'virtual'),
    collapseThreshold: c.get<number>('collapseThreshold', 300),
    edgeThreshold: c.get<number>('edgeThreshold', 300),
    wiresOnDemand: c.get<boolean>('wiresOnDemand', false),
    groupByFile: c.get<boolean>('groupByFile', false),
    maxBalls: c.get<number>('anim.maxBalls', 30),
    logMax: c.get<number>('log.maxEntries', 5000),
    logShowHidden: c.get<boolean>('log.showHidden', false),
    bridgeHidden: c.get<boolean>('bridgeHidden', true),
    colorScheme: c.get<'vscode' | 'n8n' | 'comfy' | 'high-contrast'>('colorScheme', 'vscode'),
    showGuideOnStart: c.get<boolean>('showGuideOnStart', true),
    followStepMs: c.get<number>('follow.stepMs', 500),
    followScope: c.get<'all' | 'selected' | 'filtered'>('follow.scope', 'filtered'),
    followCamera: c.get<'pan' | 'panZoom' | 'off'>('follow.camera', 'pan'),
    pack: c.get<'temporary' | 'keep' | 'off'>('pack', 'temporary'),
    interceptTimeoutSec: c.get<number>('intercept.timeoutSec', 300),
    trace: {
      maxValueLength: c.get<number>('trace.maxValueLength', 200),
      history: c.get<number>('trace.history', 1),
      flushMs: c.get<number>('trace.flushMs', 50),
      glowMs: c.get<number>('trace.glowMs', 600),
      globals: c.get<boolean>('trace.globals', false),
      persistValues: c.get<boolean>('trace.persistValues', false),
      valueDepth: c.get<number>('trace.valueDepth', 3),
      valueItems: c.get<number>('trace.valueItems', 20),
    },
  };
}

/** `guideSeen`: the guide was already shown once (global state). */
export function canvasSettings(guideSeen = true): CanvasSettings {
  const c = cfg();
  return { collapseThreshold: c.collapseThreshold, edgeThreshold: c.edgeThreshold, glowMs: c.trace.glowMs, levelMode: c.levelMode, history: c.trace.history,
    groupByFile: c.groupByFile, maxBalls: c.maxBalls, logMax: c.logMax, logShowHidden: c.logShowHidden, bridgeHidden: c.bridgeHidden,
    colorScheme: c.colorScheme, showGuide: c.showGuideOnStart && !guideSeen,
    followStepMs: c.followStepMs, followScope: c.followScope, followCamera: c.followCamera,
    pack: c.pack };
}
