import { defineConfig } from 'oxlint'

export default defineConfig({
    plugins: ['typescript', 'oxc', 'unicorn', 'import', 'promise'],
    options: { typeCheck: true, typeAware: true },
    rules: {
        'typescript/only-throw-error': 'error',
        'typescript/promise-function-async': 'error',
        'no-console': 'warn',
        'no-unused-expressions': 'warn',
        'no-array-constructor': 'warn',
        'typescript/no-explicit-any': 'warn',
        'typescript/no-require-imports': 'warn',
        'typescript/ban-ts-comment': ['warn', { 'ts-expect-error': 'allow-with-description' }],
        'typescript/no-non-null-assertion': 'warn',
        'typescript/no-unsafe-function-type': 'warn',
        'typescript/no-empty-object-type': 'warn',
        'typescript/no-unnecessary-type-constraint': 'warn',
        'typescript/explicit-function-return-type': ['warn', { allowExpressions: true }],
    },
    overrides: [
        {
            files: ['src/main.ts', 'src/generate-key.ts'],
            rules: { 'no-console': 'off' },
        },
        {
            files: ['test/**/*.ts'],
            rules: { 'typescript/no-floating-promises': 'off', 'typescript/no-non-null-assertion': 'off' },
        },
        {
            files: ['src/steps.ts'],
            rules: { 'no-unused-vars': 'off' },
        },
    ],
})
