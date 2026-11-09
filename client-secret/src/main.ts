import { buildApp } from './app.ts'
import { configProblems, readConfig, type Config } from './config.ts'

function loadConfig(): Config {
    try {
        return readConfig()
    } catch (error) {
        const problems = configProblems(error)

        if (!problems) {
            throw error
        }

        console.error(
            [
                'Configuration problem in .env:',
                ...problems.map((problem) => `- ${problem}`),
                'See "Configure" in README.md',
            ].join('\n'),
        )
        process.exit(1)
    }
}

const config = loadConfig()
const app = await buildApp(config)

await app.listen({ port: config.port, host: '127.0.0.1' })
