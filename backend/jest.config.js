/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    // `roots` + a RELATIVE testMatch, rather than a '<rootDir>/...' glob.
    // <rootDir> expands to an absolute path, and when the checkout lives under a
    // dot-directory — a git worktree at .claude/worktrees/<name> — the expanded
    // glob contains "\." which micromatch reads as an escaped dot rather than a
    // separator + literal dot. testMatch then silently matches ZERO files and
    // jest exits "no tests found", which reads exactly like a broken checkout.
    // Anchoring with `roots` keeps the pattern relative and path-agnostic.
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js'],
    globals: {
        'ts-jest': {
            tsconfig: '<rootDir>/tsconfig.json',
        },
    },
};
