'use strict';

// Conventional Commits gate. Used by .husky/commit-msg.
// Allowed types: feat, fix, perf, refactor, docs, test, chore, ci, build, style.
module.exports = {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'subject-case': [0],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [1, 'always', 200],
  },
};
