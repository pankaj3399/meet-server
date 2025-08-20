const stripe = require('../model/stripe');
const mongoose = require('mongoose');
const transaction = require('../model/transaction');

/*
 * coupon.validateEventCoupon()
 * Validate a promotion code with Stripe and return price preview for the event transaction
 */
exports.validateEventCoupon = async function (req, res) {
  try {
    const code = (req.body?.code || '').trim();
    if (!code) return res.status(400).send({ error: 'Invalid coupon' });

    // Transaction id must be provided from client to compute original amount
    const txId = req.body?.transaction;
    if (!txId) return res.status(400).send({ error: 'Invalid transaction' });
    const tx = await transaction.getById({ id: new mongoose.Types.ObjectId(txId) });
    if (!tx) return res.status(400).send({ error: 'Invalid transaction' });

    const promo = await stripe.promotionCode.findByCode({ code });
    if (!promo || !promo.active || promo.coupon?.valid === false) {
      return res.status(400).send({ error: 'Invalid coupon' });
    }

    // Prevent reuse by same user if promo code metadata indicates manual redemption
    if (promo?.metadata?.manually_redeemed === 'true' && String(promo?.metadata?.redeemed_by_user_id) === String(req.user.id)) {
      return res.status(400).send({ error: 'Invalid coupon' });
    }

    const amountCents = Math.round((tx.amount || 0) * 100);
    let discountCents = 0;
    if (promo.coupon.amount_off) discountCents = Math.min(promo.coupon.amount_off, amountCents);
    else if (promo.coupon.percent_off) discountCents = Math.floor((promo.coupon.percent_off / 100) * amountCents);

    const finalCents = Math.max(amountCents - discountCents, 0);

    // If this preview already implies a free order, indicate that redemption will be recorded on pay
    const free = finalCents < 50;
    return res.status(200).send({ data: {
      coupon: {
        id: promo.id,
        code: promo.code,
        coupon_id: promo.coupon?.id,
        amount_off: promo.coupon?.amount_off || null,
        percent_off: promo.coupon?.percent_off || null,
        currency: promo.coupon?.currency || 'eur'
      },
      price: {
        original: (amountCents/100).toFixed(2),
        discount: (discountCents/100).toFixed(2),
        final: (finalCents/100).toFixed(2)
      },
      free
    }});
  } catch (err) {
    return res.status(400).send({ error: err.message || 'Invalid coupon' });
  }
};


