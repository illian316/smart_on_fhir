import type { FastifyRequest } from 'fastify'

import type { Config } from './config.ts'
import { escapeHtml, page } from './http.ts'
import type { Session } from './types.ts'

export interface RouteDeps {
    config: Config
    requireSession: (request: FastifyRequest) => Session
}

export function navigation(): string {
    return `
        <nav>
            <a href="/app">Consultation</a>
            <a href="/clinical">Clinical summary</a>
            <a href="/scopes">Scope detective</a>
            <a href="/write">Write back</a>
        </nav>
    `
}

export function appPage(title: string, content: string): string {
    return page(title, `${navigation()}${content}`)
}

export function scopeHint(missing: string[]): string {
    const list = missing.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(' ')

    return `
        <p>This needs scopes the server did not grant: ${list}</p>
        <p>Add them to <code>SCOPES</code> in <code>.env</code>, restart the app and launch again from the EPJ.</p>
    `
}
