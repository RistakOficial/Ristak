import type { AutomationEdge, AutomationNode } from '@/services/automationsService'

// Estado del flujo con historial para deshacer/rehacer.
// El viewport se maneja aparte: el zoom/pan no genera pasos de historial.

export interface FlowSnapshot {
  nodes: AutomationNode[]
  edges: AutomationEdge[]
}

export interface EditorHistoryState {
  past: FlowSnapshot[]
  present: FlowSnapshot
  future: FlowSnapshot[]
  /** Número de cambios confirmados (para detectar cambios sin guardar) */
  revision: number
}

const HISTORY_LIMIT = 60

export type EditorAction =
  | { type: 'init'; flow: FlowSnapshot }
  | { type: 'commit'; flow: FlowSnapshot }
  | { type: 'replace'; flow: FlowSnapshot }
  | { type: 'undo' }
  | { type: 'redo' }

export function createEditorState(flow: FlowSnapshot): EditorHistoryState {
  return { past: [], present: flow, future: [], revision: 0 }
}

export function editorReducer(state: EditorHistoryState, action: EditorAction): EditorHistoryState {
  switch (action.type) {
    case 'init':
      return createEditorState(action.flow)

    // Cambio con punto de historial (crear/eliminar/conectar/configurar)
    case 'commit': {
      const past = [...state.past, state.present].slice(-HISTORY_LIMIT)
      return { past, present: action.flow, future: [], revision: state.revision + 1 }
    }

    // Cambio sin punto de historial (posición durante un arrastre)
    case 'replace':
      return { ...state, present: action.flow, revision: state.revision + 1 }

    case 'undo': {
      if (state.past.length === 0) return state
      const previous = state.past[state.past.length - 1]
      return {
        past: state.past.slice(0, -1),
        present: previous,
        future: [state.present, ...state.future],
        revision: state.revision + 1
      }
    }

    case 'redo': {
      if (state.future.length === 0) return state
      const [next, ...rest] = state.future
      return {
        past: [...state.past, state.present],
        present: next,
        future: rest,
        revision: state.revision + 1
      }
    }

    default:
      return state
  }
}
