import js from '@eslint/js';

export default [
    {ignores: ['build/', 'dist/', 'node_modules/']},
    js.configs.recommended,
    {
        languageOptions: {
            ecmaVersion: 2024,
            sourceType: 'module',
            // What GJS and GNOME Shell provide.
            globals: {
                ARGV: 'readonly',
                console: 'readonly',
                global: 'readonly',
                imports: 'readonly',
                log: 'readonly',
                logError: 'readonly',
                print: 'readonly',
                printerr: 'readonly',
                TextDecoder: 'readonly',
                TextEncoder: 'readonly',
            },
        },
        rules: {
            // A subset of GNOME Shell's rules that concern correctness and clarity.
            'curly': ['error', 'multi-or-nest', 'consistent'],
            'eqeqeq': 'error',
            'no-empty': ['error', {allowEmptyCatch: true}],
            'no-unused-vars': ['error', {args: 'none'}],
            'no-var': 'error',
            'prefer-const': 'error',
        },
    },
];
