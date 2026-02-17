/**
 * Operation state management for recovery from failures.
 * Stores state in .datacore/state/operations.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { OperationState, OperationStep } from './types'

const STATE_DIR = join(process.env.HOME || '~', 'Data', '.datacore', 'state')
const STATE_FILE = join(STATE_DIR, 'operations.json')

interface StateStore {
  operations: OperationState[]
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true })
  }
}

function loadState(): StateStore {
  ensureStateDir()
  if (!existsSync(STATE_FILE)) {
    return { operations: [] }
  }
  try {
    const content = readFileSync(STATE_FILE, 'utf-8')
    return JSON.parse(content) as StateStore
  } catch {
    return { operations: [] }
  }
}

function saveState(state: StateStore): void {
  ensureStateDir()
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

function generateId(): string {
  return `op_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

export class Operation {
  private state: OperationState
  private store: StateStore

  constructor(operation: string, params: Record<string, unknown>) {
    this.store = loadState()
    this.state = {
      id: generateId(),
      operation,
      status: 'pending',
      startedAt: new Date().toISOString(),
      steps: [],
      rollback: [],
      meta: Object.keys(params).length > 0 ? params : undefined,
    }
    this.store.operations.push(this.state)
    saveState(this.store)
  }

  get id(): string {
    return this.state.id
  }

  start(): void {
    this.state.status = 'in_progress'
    this.save()
  }

  addStep(name: string): void {
    this.state.steps.push({ name, status: 'pending' })
    this.save()
  }

  updateStep(name: string, status: OperationStep['status'], error?: string): void {
    const step = this.state.steps.find(s => s.name === name)
    if (step) {
      step.status = status
      if (error) step.error = error
      this.save()
    }
  }

  startStep(name: string): void {
    this.updateStep(name, 'in_progress')
  }

  completeStep(name: string): void {
    this.updateStep(name, 'completed')
  }

  failStep(name: string, error: string): void {
    this.updateStep(name, 'failed', error)
  }

  addRollback(command: string): void {
    if (!this.state.rollback) this.state.rollback = []
    this.state.rollback.push(command)
    this.save()
  }

  complete(): void {
    this.state.status = 'completed'
    this.save()
    // Remove completed operations from store
    this.store.operations = this.store.operations.filter(op => op.id !== this.state.id)
    saveState(this.store)
  }

  fail(error: string): void {
    this.state.status = 'failed'
    // Add error to last step if exists
    const lastStep = this.state.steps[this.state.steps.length - 1]
    if (lastStep && lastStep.status === 'in_progress') {
      lastStep.status = 'failed'
      lastStep.error = error
    }
    this.save()
  }

  private save(): void {
    const idx = this.store.operations.findIndex(op => op.id === this.state.id)
    if (idx !== -1) {
      this.store.operations[idx] = this.state
    }
    saveState(this.store)
  }
}

export function startOperation(operation: string, params: Record<string, unknown> = {}): Operation {
  return new Operation(operation, params)
}

export function listOperations(): OperationState[] {
  const store = loadState()
  return store.operations
}

export function getOperation(id: string): OperationState | undefined {
  const store = loadState()
  return store.operations.find(op => op.id === id)
}

export function clearOperation(id: string): boolean {
  const store = loadState()
  const idx = store.operations.findIndex(op => op.id === id)
  if (idx !== -1) {
    store.operations.splice(idx, 1)
    saveState(store)
    return true
  }
  return false
}

export function clearAllOperations(): void {
  saveState({ operations: [] })
}
