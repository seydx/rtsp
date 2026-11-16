export default {
  exclude: ['typescript', 'eslint', '@eslint/js'],
  // types must match the node 24 runtime we target
  pin: {
    '@types/node': '^24',
  },
  cooldown: '7d',
  overrides: [{ include: [/^(@camera\.ui\/|camera\.ui$|node-av(-light|-lgpl)?$|@seydx\/|camera[-_]ui[-_]|github\.com\/(cameraui|seydx)\/)/], cooldown: 0 }],
};
