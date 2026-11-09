import * as reference from '../src/reference.ts'
import { steps, type Steps } from '../src/steps.ts'

export const IMPLEMENTATIONS: Record<string, Steps> = { Reference: reference, Solution: steps }
