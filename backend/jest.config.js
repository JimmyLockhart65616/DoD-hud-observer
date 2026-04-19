/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    rootDir: '.',
    testMatch: ['<rootDir>/src/**/__tests__/**/*.test.ts'],
    moduleFileExtensions: ['ts', 'js'],
    globals: {
        'ts-jest': {
            tsconfig: '<rootDir>/tsconfig.json',
        },
    },
};
