import { randomBytes } from 'node:crypto'
import { z } from 'zod'

import { AppError } from './config.ts'

const REQUEST_TIMEOUT_MS = 10_000

const RANDOM_TOKEN_BYTES = 32

const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
}

export async function request(url: string, init: RequestInit = {}): Promise<Response> {
    const response = await fetch(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    if (!response.ok) {
        throw new AppError(502, `Upstream returned HTTP ${response.status}. Check scopes and registration.`)
    }

    return response
}

export async function json<T>(url: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
    const response = await request(url, init)

    return schema.parse(await response.json())
}

export function escapeHtml(value: unknown): string {
    return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPES[char as keyof typeof HTML_ESCAPES])
}

export function page(title: string, content: string): string {
    const heading = escapeHtml(title)

    return `
        <!doctype html>
        <html lang="en">
            <head>
                <meta charset="utf-8">
                <meta name="viewport" content="width=device-width">
                <title>${heading}</title>
            </head>
            <body>
                <main>
                    <h1>${heading}</h1>
                    ${content}
                </main>
            </body>
        </html>
    `.trim()
}

export function randomToken(): string {
    return randomBytes(RANDOM_TOKEN_BYTES).toString('base64url')
}
