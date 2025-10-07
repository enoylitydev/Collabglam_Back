exports.getFeature = (subscription, key) =>
  subscription.features.find(f => f.key === key);
