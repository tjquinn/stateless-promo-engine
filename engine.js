class RequirementMatcher {
  static itemMatchesRequirement(item, requirement) {
    if (!item || !requirement) {
      return false;
    }

    if (requirement.match_type === 'sku') {
      return item.sku === requirement.value;
    }

    if (requirement.match_type === 'category') {
      return item.category === requirement.value;
    }

    return false;
  }

  static allocateRequirementUnits(cart, requirement, usedUnitsByIndex) {
    const quantityNeeded = Number(requirement.quantity) || 0;
    let remaining = quantityNeeded;
    const matchedIndices = [];

    if (remaining <= 0) {
      return { matchedIndices, remaining: 0 };
    }

    for (let index = 0; index < cart.length; index += 1) {
      const item = cart[index];
      if (!RequirementMatcher.itemMatchesRequirement(item, requirement)) {
        continue;
      }

      const availableUnits = Math.max(0, item.quantity - (usedUnitsByIndex[index] || 0));
      if (availableUnits <= 0) {
        continue;
      }

      while (remaining > 0 && availableUnits > 0) {
        usedUnitsByIndex[index] = (usedUnitsByIndex[index] || 0) + 1;
        matchedIndices.push(index);
        remaining -= 1;
        if (usedUnitsByIndex[index] >= item.quantity) {
          break;
        }
      }

      if (remaining <= 0) {
        break;
      }
    }

    return { matchedIndices, remaining };
  }

  static buildRequirementMatches(cart, requiredSet) {
    if (!requiredSet || !Array.isArray(requiredSet.items) || requiredSet.items.length === 0) {
      return { valid: false, matchedByIndex: [], reason: 'Required set is empty.' };
    }

    const usedUnitsByIndex = new Array(cart.length).fill(0);
    const matchedByIndex = [];

    for (const requirement of requiredSet.items) {
      const allocation = RequirementMatcher.allocateRequirementUnits(cart, requirement, usedUnitsByIndex);
      if (allocation.remaining > 0) {
        return {
          valid: false,
          matchedByIndex: [],
          reason: `Insufficient match for ${requirement.match_type}:${requirement.value}`,
        };
      }
      matchedByIndex.push(...allocation.matchedIndices);
    }

    return { valid: true, matchedByIndex };
  }
}

class SetTotalsCalculator {
  static computeSetTotals(cart, matchedIndices) {
    const matchedUnitsByItem = new Map();

    for (const index of matchedIndices) {
      const item = cart[index];
      if (!matchedUnitsByItem.has(index)) {
        matchedUnitsByItem.set(index, { item, units: 0 });
      }
      matchedUnitsByItem.get(index).units += 1;
    }

    const entries = Array.from(matchedUnitsByItem.values());
    const setTotal = entries.reduce((sum, entry) => sum + (entry.item.unitPrice * entry.units), 0);
    const cheapestEntry = entries.reduce((best, current) => {
      if (!best) {
        return current;
      }
      return current.item.unitPrice < best.item.unitPrice ? current : best;
    }, null);

    return { entries, setTotal, cheapestEntry };
  }
}

class RewardCalculator {
  static applyRewardToSet(cart, matchedIndices, reward, subtotal) {
    const { entries, setTotal, cheapestEntry } = SetTotalsCalculator.computeSetTotals(cart, matchedIndices);

    if (reward.target === 'cheapest_item_in_set' && !cheapestEntry) {
      return { discountAmount: 0, finalTotal: subtotal, matchedSetTotal: 0 };
    }

    let discountAmount = 0;

    if (reward.discount_type === 'percentage') {
      const percentage = Number(reward.discount_value) || 0;
      if (reward.target === 'entire_set') {
        discountAmount = setTotal * (percentage / 100);
      } else if (reward.target === 'cheapest_item_in_set') {
        const eligiblePrice = cheapestEntry.item.unitPrice * cheapestEntry.units;
        discountAmount = eligiblePrice * (percentage / 100);
      }
    }

    if (reward.discount_type === 'fixed_package_price') {
      const fixedPrice = Number(reward.discount_value) || 0;
      if (reward.target === 'entire_set') {
        discountAmount = Math.max(0, setTotal - fixedPrice);
      } else if (reward.target === 'cheapest_item_in_set') {
        const eligiblePrice = cheapestEntry.item.unitPrice * cheapestEntry.units;
        discountAmount = Math.max(0, eligiblePrice - fixedPrice);
      }
    }

    const finalTotal = Math.max(0, subtotal - discountAmount);
    return { discountAmount, finalTotal, setTotal, matchedEntries: entries };
  }
}

class PromotionEvaluator {
  static evaluatePromotion(cart, promotion) {
    if (!promotion || !promotion.required_set) {
      return { valid: false, reason: 'Promotion is missing required_set' };
    }

    const setMatch = RequirementMatcher.buildRequirementMatches(cart, promotion.required_set);
    if (!setMatch.valid) {
      return { valid: false, reason: setMatch.reason };
    }

    const subtotal = cart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const reward = promotion.reward || {};
    const rewardResult = RewardCalculator.applyRewardToSet(cart, setMatch.matchedByIndex, reward, subtotal);

    return {
      valid: true,
      code: promotion.code,
      matchedByIndex: setMatch.matchedByIndex,
      reward,
      subtotal,
      discountAmount: rewardResult.discountAmount,
      finalTotal: rewardResult.finalTotal,
      matchedSetTotal: rewardResult.setTotal,
      matchedEntries: rewardResult.matchedEntries,
    };
  }
}

class CartEvaluator {
  static normalizeCart(cart) {
    return cart
      .map((item) => ({
        sku: item.sku,
        category: item.category,
        name: item.name,
        quantity: Number(item.quantity) || 0,
        unitPrice: Number(item.unitPrice) || 0,
      }))
      .filter((item) => item.quantity > 0 && item.unitPrice >= 0);
  }

  static evaluateCart(cart, promotions) {
    const normalizedCart = CartEvaluator.normalizeCart(cart);
    const subtotal = normalizedCart.reduce((sum, item) => sum + (item.unitPrice * item.quantity), 0);
    const promotionResults = [];

    if (Array.isArray(promotions)) {
      for (const promotion of promotions) {
        const evaluation = PromotionEvaluator.evaluatePromotion(normalizedCart, promotion);
        if (evaluation.valid) {
          promotionResults.push(evaluation);
        }
      }
    }

    promotionResults.sort((left, right) => right.discountAmount - left.discountAmount);

    const selectedPromotion = promotionResults[0] || null;
    const grandTotal = selectedPromotion ? selectedPromotion.finalTotal : subtotal;
    const savings = selectedPromotion ? selectedPromotion.discountAmount : 0;

    return {
      subtotal,
      grandTotal,
      savings,
      promotions: promotionResults,
      appliedPromotion: selectedPromotion,
      itemCount: normalizedCart.length,
    };
  }
}

function buildRequirementMatches(cart, requiredSet) {
  return RequirementMatcher.buildRequirementMatches(cart, requiredSet);
}

function evaluatePromotion(cart, promotion) {
  return PromotionEvaluator.evaluatePromotion(cart, promotion);
}

function evaluateCart(cart, promotions) {
  return CartEvaluator.evaluateCart(cart, promotions);
}

module.exports = {
  RequirementMatcher,
  SetTotalsCalculator,
  RewardCalculator,
  PromotionEvaluator,
  CartEvaluator,
  evaluatePromotion,
  evaluateCart,
  buildRequirementMatches,
};
