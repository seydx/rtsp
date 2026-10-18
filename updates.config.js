export default {
  exclude: ['typescript', 'eslint', '@eslint/js'],
  // types must match the node 24 runtime we target
  pin: {
    '@types/node': '^24',
  },
};
