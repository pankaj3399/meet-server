const config = require('config');
const domain = config.get('domain');
const event = require('../model/event-management');
const registeredParticipant = require('../model/registered-participant');
const user = require('../model/user');
const auth = require('../model/auth');
const transaction = require('../model/transaction');
const utility = require('../helper/utility');
const mongoose = require('mongoose');
const s3 = require('../helper/s3');
const path = require('path');
const stripe = require('../model/stripe');
const joi = require('joi');
const account = require('../model/account');
const mail = require('../helper/mail');
const token = require('../model/token');
const ageUtil = require('../helper/age');
require('dotenv').config()
const RegisteredParticipant = mongoose.model("RegisteredParticipant");
const Waitlist = mongoose.model("Waitlist");
const CHECK_FOR_THRESHOLD_START = process.env.CHECK_FOR_THRESHOLD_START
const checkEventFull = async (eventId) => {
  const eventData = await event.getById({ id: eventId });
  const registeredCount = await RegisteredParticipant.countDocuments({
    event_id: eventId,
    status: "registered",
  });

  const totalCapacity = eventData.bars.reduce(
    (sum, bar) => sum + bar.available_spots,
    0
  );

  if (registeredCount >= totalCapacity) {
    throw { message: "Event is full. No more registrations allowed." };
  }

  return true;
};

const verifyAgeGroup = (mainUser, friend, age_group) => {
  const mainUserAge = ageUtil.getAgeFromDOB(mainUser.date_of_birth);
  const friendAge = (friend && friend.email) ? ageUtil.getAgeFromDOB(friend.date_of_birth) : null;
  if (age_group == "20–30") {
    if (mainUserAge < 20 || mainUserAge > 30) {
      return false
    }
    if (friendAge) {
      if (friendAge < 20 || friendAge > 30) {
        return false
      }
    }
  }
  else if (age_group == "31–40") {
    if (mainUserAge < 31 || mainUserAge > 40) {
      return false
    }
    if (friendAge) {
      if (friendAge < 31 || friendAge > 40) {
        return false
      }
    }
  }
  else if (age_group == "41–50") {
    if (mainUserAge < 41 || mainUserAge > 50) {
      return false
    }
    if (friendAge) {
      if (friendAge < 41 || friendAge > 50) {
        return false
      }
    }
  }
  else if (age_group == "50+") {
    if (mainUserAge < 50) {
      return false
    }
    if (friendAge) {
      if (friendAge < 50) {
        return false
      }
    }
  }
  return true
}

const checkGenderRatio = async (mainUser, friend, eventId, age_group, session) => {
  console.log("Hello hellooooooooooo")
  console.log(mainUser, 'mainUser');
  console.log(friend, 'friend');
  const eventParticipants = await RegisteredParticipant.find({
    event_id: eventId,
    status: "registered",
    age_group: age_group
  }).session(session ? session : null);

  let threshold = CHECK_FOR_THRESHOLD_START - 1
  if (friend && friend.email) {
    threshold = CHECK_FOR_THRESHOLD_START - 2
  }
  console.log(eventParticipants.length, 'eventParticipants.length');
  console.log(threshold, 'threshold');
  if (eventParticipants.length < threshold) {
    return true
  }

  let maleParticipantsCount = eventParticipants.filter(participant => participant.gender === "male").length
  let femaleParticipantsCount = eventParticipants.filter(participant => participant.gender === "female").length

  let isRegisteringMale = false

  if (mainUser.gender == "male") {
    maleParticipantsCount++
    isRegisteringMale = true
  }
  else if (mainUser.gender == "female") {
    femaleParticipantsCount++
    isRegisteringMale = false
  }

  if (friend && friend.email) {
    if (friend.gender == "male") {
      maleParticipantsCount++
    }
    else if (friend.gender == "female") {
      femaleParticipantsCount++
    }
  }

  const totalParticipants = maleParticipantsCount + femaleParticipantsCount

  const maleRatio = (maleParticipantsCount / totalParticipants) * 100
  const femaleRatio = (femaleParticipantsCount / totalParticipants) * 100

  if (isRegisteringMale && maleRatio > 60) {
    return false
  }
  else if (!isRegisteringMale && femaleRatio > 60) {
    return false
  }
  return true
}

const checkCapacityWithWarning = async (eventId) => {
  const eventData = await event.getById({ id: eventId });
  const currentRegistrations = await RegisteredParticipant.countDocuments({
    event_id: eventId,
    status: "registered",
  });

  const allRegistrations = await RegisteredParticipant.find({
    event_id: eventId,
    status: "registered",
  }).populate("user_id", "first_name last_name email");

  const totalCapacity = eventData.bars.reduce(
    (sum, bar) => sum + bar.available_spots,
    0
  );
  if (currentRegistrations >= totalCapacity) {
    throw { message: "Event is full. No more registrations allowed." };
  }

  return {
    current: currentRegistrations,
    total: totalCapacity,
    available: totalCapacity - currentRegistrations,
    registrations: allRegistrations.map((reg) => ({
      participant_id: reg._id,
      user_name: `${reg.user_id.first_name} ${reg.user_id.last_name}`,
      email: reg.user_id.email,
      status: reg.status,
      is_main_user: reg.is_main_user,
      registered_at: reg.createdAt,
    })),
  };
};

const addToWaitlist = async (mainParticipant, friendParticipant, eventId, age_group, session) => {
  const existingWaitlist = await Waitlist.findOne({
    event_id: eventId,
    user_id: mainParticipant.user_id,
    age_group: age_group
  })

  if (existingWaitlist) {
    return
  }
  await Waitlist.create([{
    event_id: eventId,
    user_id: mainParticipant.user_id,
    participant_id: mainParticipant._id,
    age_group: age_group,
    invited_user_id: friendParticipant ? friendParticipant.user_id : null,
    sub_participant_id: friendParticipant ? friendParticipant._id : null
  }], {
    session: session ? session : null
  });
}

const sendEventAvailabilityMailToWaitlist = async (registration, res) => {
  try {
    const waitlistedParticipants = await Waitlist.find({
      event_id: registration.event_id,
      age_group: registration.age_group
    }).populate("user_id", "email first_name locale")

    console.log(waitlistedParticipants, 'waitlistedParticipants');

    const Transaction = mongoose.model('Transaction');
    waitlistedParticipants.forEach(async (participant) => {
      let payment;
      const existingPayment = await Transaction.findOne({
        user_id: participant.user_id._id,
        type: 'Register Event',
        status: 'unpaid',
        event_id: participant.event_id,
        amount: participant.sub_participant_id ? 40 : 20,
        ...participant.sub_participant_id && { sub_participant_id: [participant.sub_participant_id] },
        ...participant.invited_user_id && { invited_user_id: participant.invited_user_id },
      })
      if (existingPayment) {
        payment = existingPayment
      }
      else {
        payment = await transaction.create({
          user_id: participant.user_id._id,
          participant_id: participant.participant_id,
          ...participant.sub_participant_id && { sub_participant_id: [participant.sub_participant_id] },
          ...participant.invited_user_id && { invited_user_id: registerFriend.invited_user_id },
          type: 'Register Event',
          amount: participant.sub_participant_id ? 40 : 20,
          event_id: participant.event_id,
          status: 'unpaid'
        })
      }
      await mail.send({
        to: participant.user_id.email,
        locale: participant.user_id.locale || 'en',
        template: 'template',
        subject: res.__({ phrase: 'waitlist.alert.subject', locale: participant.user_id.locale || 'en' }),
        custom: true,
        content: {
          body: res.__({ phrase: 'waitlist.alert.body', locale: participant.user_id.locale || 'en' }, {
            name: participant.user_id.first_name,
            amount: payment.amount
          }),
          button_label: res.__({ phrase: 'waitlist.alert.button-label', locale: participant.user_id.locale || 'en' }),
          button_url: `${process.env.CLIENT_URL}/event/${payment._id}?source=mail`
        }
      })
      console.log('Mail for link', `${process.env.CLIENT_URL}/event/${payment._id}`, 'sent');

    })
  } catch (error) {
    console.log('error', error);
  }
}

/*
 * registerParticipant.create()
 */
exports.create = async function (req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const idUser = req.user;
    utility.assert(req.body, ['mainUser', 'friend', 'id'], res.__('register_participant.invalid'));
    const { mainUser, friend, id, age_group } = req.body

    await checkEventFull(id);
    const ageGroupCheck = verifyAgeGroup(mainUser, friend, age_group);
    if (!ageGroupCheck) {
      throw ({ message: res.__('register_participant.age_group.invalid') })
    }
    const userData = await user.get({ id: idUser });
    const existingRegistration = await RegisteredParticipant.findOne({
      user_id: userData._id,
      event_id: id,
      age_group: age_group,
      status: { $in: ['registered', 'waitlist', 'process'] }
    })

    if (existingRegistration) {
      throw ({ message: res.__('register_participant.already_registered') })
    }
    let registerFriend;
    let friendAdded;

    const genderRatioCheck = await checkGenderRatio(mainUser, friend, id, age_group, session);
    if (friend?.email) {
      if (mainUser.email === friend.email)
        throw ({ message: res.__('user.create.duplicate') })

      const friendData = await user.get({ email: friend.email });

      if (!friendData) {
        friend.verified = true
        friend.default_account = null
        friend.is_invited = true
        friend.name = `${friend.first_name} ${friend.last_name}`
        friend.children = friend.children === 'Yes' ? true : false;
        friendAdded = await user.create({ user: friend })
        console.log(friendAdded, 'friendAdded');

        console.log('====get id users', idUser);
      } else {
        friendAdded = friendData;
      }

      registerFriend = await registeredParticipant.create({
        user_id: friendAdded._id,
        event_id: id,
        first_name: friend.first_name,
        last_name: friend.last_name,
        gender: friend.gender || null,
        date_of_birth: friend.date_of_birth,
        age_group: age_group,
        children: friend.children === 'Yes' ? true : false,
        email: friend.email,
        is_main_user: false,
        relationship_goal: friend.relationship_goal,
        kind_of_person: friend.kind_of_person,
        feel_around_new_people: friend.feel_around_new_people,
        prefer_spending_time: friend.prefer_spending_time,
        describe_you_better: friend.describe_you_better,
        describe_role_in_relationship: friend.describe_role_in_relationship,
        looking_for: friend.looking_for,
        status: genderRatioCheck ? 'process' : 'waitlist'
      }, session)
      console.log(registerFriend, 'registerFriend');

    }
    const registerMainUser = await registeredParticipant.create({
      user_id: userData._id,
      event_id: id,
      first_name: mainUser.first_name,
      last_name: mainUser.last_name,
      gender: mainUser.gender || null,
      date_of_birth: mainUser.date_of_birth,
      age_group: age_group,
      children: mainUser.children === 'Yes' ? true : false,
      email: mainUser.email,
      is_main_user: true,
      relationship_goal: mainUser.relationship_goal,
      kind_of_person: mainUser.kind_of_person,
      feel_around_new_people: mainUser.feel_around_new_people,
      prefer_spending_time: mainUser.prefer_spending_time,
      describe_you_better: mainUser.describe_you_better,
      describe_role_in_relationship: mainUser.describe_role_in_relationship,
      looking_for: mainUser.looking_for,
      status: genderRatioCheck ? 'process' : 'waitlist'
    }, session)
    await user.update({
      _id: new mongoose.Types.ObjectId(userData._id),
      data: {
        kind_of_person: mainUser.kind_of_person,
        feel_around_new_people: mainUser.feel_around_new_people,
        prefer_spending_time: mainUser.prefer_spending_time,
        describe_you_better: mainUser.describe_you_better,
        describe_role_in_relationship: mainUser.describe_role_in_relationship
      }
    })
    console.log(registerMainUser, 'registerMainUser');
    if (!genderRatioCheck) {
      await addToWaitlist(registerMainUser, registerFriend, id, age_group, session)
      await session.commitTransaction();
      await session.endSession();
      return res.status(200).send({
        data: {
          status: 'waitlist',
          message: res.__('register_participant.waitlist')
        }
      })
    }
    const payment = await transaction.create({
      user_id: userData._id,
      participant_id: registerMainUser._id,
      ...registerFriend && { sub_participant_id: [registerFriend._id] },
      ...registerFriend && { invited_user_id: registerFriend.user_id },
      type: 'Register Event',
      amount: registerFriend ? 40 : 20,
      event_id: id,
      status: 'unpaid'
    }, session)
    await session.commitTransaction();
    await session.endSession();
    // const register = await registeredParticipant.create();
    return res.status(200).send({
      data: {
        status: 'payment',
        id: payment._id
      }
    });
  } catch (err) {
    console.log(err, 'err');
    await session.abortTransaction();
    await session.endSession();
    return res.status(500).send({ error: err.message });
  }
};


/*
 * registerParticipant.pay()
 */
exports.pay = async function (req, res) {
  // validate
  const id = req.params.id;
  utility.assert(id, res.__('account.card.missing'));

  const data = utility.validate(joi.object({
    token: joi.object(),
    stripe: joi.object(),
    account_holder_name: joi.string(),
    sepaForm: joi.boolean(),
    credit_card_name: joi.string(),
    account: joi.boolean(),

  }), req, res);

  const stripeData = {};

  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__('account.invalid'));

  const transactionUser = await transaction.getById({ id: new mongoose.Types.ObjectId(id) })
  utility.assert(transactionUser, res.__('event.already_paid'));

  if (transactionUser && !data.account) {
    const eventData = await event.getById({ id: new mongoose.Types.ObjectId(transactionUser.event_id) })
    await checkCapacityWithWarning(transactionUser.event_id);

    // Get today's date at 00:00
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get event date and normalize to 00:00
    const eventDate = new Date(eventData.date);
    eventDate.setHours(0, 0, 0, 0);

    // If event date is before today, it's in the past
    if (eventDate < today) {
      utility.assert(eventData, res.__('event.already_held'));
    }
  }

  // const User = mongoose.model('User');
  // const mainUser = await User.findById(transactionUser.user_id)
  // console.log(mainUser, 'mainUser');
  // const mainParticipant = await RegisteredParticipant.findById(transactionUser.participant_id)
  // if (!mainUser) {
  //   utility.assert(mainUser, res.__('user.invalid'));
  // }
  // let friend = null
  // if (transactionUser.invited_user_id) {
  //   friend = await User.findById(transactionUser.invited_user_id)
  // }

  // const genderRatioCheck = await checkGenderRatio(mainUser, friend, transactionUser.event_id, mainParticipant.age_group);

  // if (!genderRatioCheck) {
  //   let friendParticipant = null
  //   if (transactionUser.invited_user_id) {
  //     friendParticipant = await RegisteredParticipant.findOne({
  //       id: new mongoose.Types.ObjectId(transactionUser.sub_participant_id[0])
  //     })
  //   }
  //   if (mainParticipant.status != 'waitlist') {
  //     await addToWaitlist(mainParticipant, friendParticipant, transactionUser.event_id, mainParticipant.age_group);
  //     await registeredParticipant.findOneAndUpdate({
  //       id: new mongoose.Types.ObjectId(mainParticipant._id),
  //     }, {
  //       status: 'waitlist'
  //     })
  //     friendParticipant && await registeredParticipant.findOneAndUpdate({
  //       id: new mongoose.Types.ObjectId(friendParticipant._id),
  //     }, {
  //       status: 'waitlist'
  //     })
  //   }
  //   return res.status(200).send({
  //     data: {
  //       status: 'waitlist',
  //       message: res.__('register_participant.waitlist')
  //     }
  //   })
  // }

  if (data.stripe === undefined) {

    utility.assert(data.token?.id, res.__('account.card.missing'));

    // create a stripe customer
    stripeData.customer = accountData.stripe_customer_id || await stripe.customer.create({ email: accountData.owner_email, name: data.sepaForm ? data.account_holder_name : data.credit_card_name, ...!data.sepaForm && { token: data.token.id } });
    let paymentIntent, paymentSepa;
    // Compute final amount using Stripe promotion code if provided
    let originalAmountCents = transactionUser ? Math.round(transactionUser.amount * 100) : 0;
    let finalAmountCents = originalAmountCents;
    let discountCents = 0;
    let couponMeta = null;
    if (req.body.coupon) {
      try {
        const promo = await stripe.promotionCode.findByCode({ code: req.body.coupon });
        if (promo && promo.active && promo.coupon?.valid !== false) {
          if (promo.coupon.amount_off) {
            discountCents = Math.min(promo.coupon.amount_off, originalAmountCents);
          } else if (promo.coupon.percent_off) {
            discountCents = Math.floor((promo.coupon.percent_off / 100) * originalAmountCents);
          }
          finalAmountCents = Math.max(originalAmountCents - discountCents, 0);
          couponMeta = { id: promo.id, code: promo.code };
        }
      } catch (e) { /* ignore invalid code */ }
    }
    // If coupon exists, block if metadata indicates it was already manually redeemed by the same user
    if (couponMeta?.id) {
      try {
        const promoCode = await stripe.promotionCode.retrieve({ id: couponMeta.id });
        // Block coupon if it has already been manually redeemed by any user
        if (promoCode?.metadata?.manually_redeemed === 'true') {
          return res.status(400).send({ error: 'Invalid coupon' });
        }
      } catch (e) { }
    }
    // If final amount is below Stripe minimum (EUR ~ 50 cents), treat as free
    const MIN_EUR_CENTS = 50;
    if (finalAmountCents < MIN_EUR_CENTS) {
      // If a coupon was used, manually mark redemption on Stripe
      if (couponMeta?.id) {
        try {
          const promoCode = await stripe.promotionCode.retrieve({ id: couponMeta.id });
          await stripe.promotionCode.update({
            id: couponMeta.id, data: {
              metadata: {
                ...(promoCode?.metadata || {}),
                manually_redeemed: 'true',
                redeemed_by_user_id: String(req.user.id),
                redeemed_at: new Date().toISOString()
              }
            }
          });
          if (promoCode?.max_redemptions === 1) {
            await stripe.promotionCode.update({ id: couponMeta.id, data: { active: false } });
          }
        } catch (e) {
          console.error('Manual promo redemption failed', e);
        }
      }
      try {
        // Mark transaction paid
        await transaction.findOneAndUpdate({ id: new mongoose.Types.ObjectId(id) }, { status: 'paid' });

        // Fetch event and update participant(s)
        const eventUser = await event.getById({ id: new mongoose.Types.ObjectId(transactionUser.event_id) });
        if (eventUser) {
          await registeredParticipant.findOneAndUpdate(
            { id: new mongoose.Types.ObjectId(transactionUser.participant_id) },
            { status: 'registered' }
          );

          // email main user
          const mainUser = await registeredParticipant.findOneAndUpdate(
            { id: new mongoose.Types.ObjectId(transactionUser.participant_id) },
            { status: 'registered' }
          );

          // Remove from waiting list if present
          await Waitlist.findOneAndDelete({
            event_id: new mongoose.Types.ObjectId(transactionUser.event_id),
            participant_id: new mongoose.Types.ObjectId(transactionUser.participant_id),
          })
          await mail.send({
            to: mainUser.email,
            locale: req.locale,
            custom: true,
            template: 'event_registered',
            subject: `${eventUser.city.name} - ${res.__('payment.registered_event.subject')}`,
            content: {
              name: `${mainUser.first_name} ${mainUser.last_name}`,
              body: res.__('payment.registered_event.body', {
                name: eventUser.city.name,
                event: eventUser.city.name,
                date: utility.formatDateString(eventUser.date || new Date()),
              }),
              button_url: process.env.CLIENT_URL,
              button_label: res.__('payment.registered_event.button'),
            },
          });

          if (Array.isArray(transactionUser?.sub_participant_id)) {
            for (const idSub of transactionUser.sub_participant_id) {
              const subUser = await registeredParticipant.findOneAndUpdate(
                { id: new mongoose.Types.ObjectId(idSub) },
                { status: 'registered' }
              );
              await mail.send({
                to: subUser.email,
                locale: req.locale,
                custom: true,
                template: 'event_registered',
                subject: `${eventUser.city.name} - ${res.__('payment.registered_event.subject')}`,
                content: {
                  name: `${subUser.first_name} ${subUser.last_name}`,
                  body: res.__('payment.registered_event.body', {
                    name: eventUser.city.name,
                    event: eventUser.city.name,
                    date: utility.formatDateString(eventUser.date || new Date()),
                  }),
                  button_url: process.env.CLIENT_URL,
                  button_label: res.__('payment.registered_event.button'),
                },
              });
            }
          }
        }
      } catch (e) {
        console.error('Free checkout finalize failed', e);
      }

      return res.status(200).send({
        requires_payment_action: false,
        transaction: id,
        amount: 0,
        price: { original: (originalAmountCents / 100), discount: (originalAmountCents / 100), final: 0 },
        ...couponMeta && { coupon: couponMeta }
      });
    }

    if (data.sepaForm) {
      paymentSepa = await stripe.customer.setappIntents(accountData.stripe_customer_id, ['sepa_debit']);

    } else {
      if (transactionUser) {
        paymentIntent = await stripe.paymentIntent({
          amount: finalAmountCents,
          id: accountData.stripe_customer_id || stripeData.customer.id,
          userId: req.user.id,
          payment_method_types: ['card'],
          // payment_method: req.body.paymentId,
        })
      }
    }
    await account.update({
      id: req.account,
      data: { stripe_customer_id: accountData.stripe_customer_id || stripeData.customer.id }
    })

    return res.status(200).send({
      requires_payment_action: true,
      customer: { id: accountData.stripe_customer_id || stripeData.customer.id },
      client_secret: (data.sepaForm ? paymentSepa : paymentIntent)?.client_secret,
      method: data.sepaForm ? 'directdebit' : 'card',
      account_holder_name: data.account_holder_name,
      email: accountData.owner_email,
      type: data.sepaForm ? 'setup' : null,
      transaction: id,
      amount: (finalAmountCents / 100),
      price: { original: (originalAmountCents / 100), discount: (discountCents / 100), final: (finalAmountCents / 100) },
      ...couponMeta && { coupon: couponMeta }
    });
  }

  console.log(res.__('account.log.event'));
  log.create({ message: res.__('account.log.event'), body: {}, req: req });
  res.status(200).send({ event: data, onboarded: false });
};

exports.checkForSlotAvailability = async function (req, res) {
  try {
    const id = req.params.id;
    const transactionUser = await transaction.getById({ id: new mongoose.Types.ObjectId(id) });

    if(transactionUser.status == "paid"){
      return res.status(200).send({
        data: {
          status: 'paid',
          message: res.__('register_participant.already_registered')
        }
      })
    }
    const User = mongoose.model('User');
    console.log(transactionUser, 'transactionUser');
    const mainUser = await User.findById(transactionUser.user_id)
    console.log(mainUser, 'mainUser');
    const mainParticipant = await RegisteredParticipant.findById(transactionUser.participant_id)
    console.log(mainParticipant, 'mainParticipant');
    if (!mainUser) {
      utility.assert(mainUser, res.__('user.invalid'));
    }
    let friend = null
    if (transactionUser.invited_user_id) {
      friend = await User.findById(transactionUser.invited_user_id)
    }

    const genderRatioCheck = await checkGenderRatio(mainUser, friend, transactionUser.event_id._id, mainParticipant.age_group);
  
    if (!genderRatioCheck) {
      let friendParticipant = null
      if (transactionUser.invited_user_id) {
        friendParticipant = await RegisteredParticipant.findOne({
          id: new mongoose.Types.ObjectId(transactionUser.sub_participant_id[0])
        })
      }
      if (mainParticipant.status != 'waitlist') {
        await addToWaitlist(mainParticipant, friendParticipant, transactionUser.event_id, mainParticipant.age_group);
        await registeredParticipant.findOneAndUpdate({
          id: new mongoose.Types.ObjectId(mainParticipant._id),
        }, {
          status: 'waitlist'
        })
        friendParticipant && await registeredParticipant.findOneAndUpdate({
          id: new mongoose.Types.ObjectId(friendParticipant._id),
        }, {
          status: 'waitlist'
        })
      }
      return res.status(200).send({
        data: {
          status: 'waitlist',
          message: res.__('register_participant.waitlist')
        }
      })
    }
    return res.status(200).send({
      data: {
        status: 'available',
        message: res.__('register_participant.available')
      }
    })
  } catch (error) {
    console.log(error);
    return res.status(500).send({
      error: error.message
    })
    
  }
}
/*
* account.sepa()
* update sepa details
*/

exports.sepa = async function (req, res) {

  utility.validate(req.body);

  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__('account.invalid'));

  if (!accountData.stripe_customer_id) {
    utility.assert(req.body.token, res.__('account.sepa.missing'), 'token');
  }

  const useExisting = req.body.useExisting;

  const setupIntent = !useExisting && await stripe.customer.setappIntents(accountData.stripe_customer_id, ['sepa_debit']);
  const customer = await stripe.customer(accountData.stripe_customer_id);

  return res.status(200).send(useExisting ? {
    message: res.__('account.sepa.updated'),
    data: true
  } : {
    requires_payment_action: true,
    method: 'directdebit',
    type: 'setup',
    client_secret: setupIntent.client_secret,
    billing_details: {
      email: req.body.email,
      name: req.body.account_holder_name,
    },
    // prefer_payment_method: req.body.prefer_payment_method,
    message: res.__('account.sepa.updated')
  });
};

/*
* account.sepa.attach()
* attach sepa payment to customer
*/

exports.sepa.attach = async function (req, res) {

  // utility.validate(req.body);
  utility.assert(req.body.transaction, res.__('account.invalid'));
  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__('account.invalid'));

  if (!accountData.stripe_customer_id) {
    utility.assert(req.body.token, res.__('account.sepa.missing'), 'token');
  }
  console.log(accountData);

  const sepaPayment = await stripe.customer.sepaSettings(req.body.paymentId, accountData.stripe_customer_id, req.body.prefer_payment_method);

  let paymentIntent;
  const transactionUser = await transaction.getById({ id: new mongoose.Types.ObjectId(req.body.transaction) })
  console.log(transactionUser);

  if (transactionUser) {
    paymentIntent = await stripe.paymentIntent({
      amount: transactionUser.amount * 100,
      id: accountData.stripe_customer_id,
      userId: req.user.id,
      payment_method: req.body.paymentId,
    })
  }

  return res.status(200).send({

    requires_payment_action: true,
    method: 'directdebit',
    client_secret: paymentIntent.client_secret,
    billing_details: {
      email: req.body.email,
      name: req.body.account_holder_name,
    },
    transaction: req.body.transaction,
    message: res.__('account.sepa.updated')
  });
};

/*
* account.card()
* get the card details for this account
*/

exports.card = async function (req, res) {

  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__('account.invalid'));

  if (accountData.stripe_customer_id) {

    const customer = await stripe.customer(accountData.stripe_customer_id);
    card = customer.sources?.data?.[0];

    const sepa = await stripe.customer.paymentMethod(accountData.stripe_customer_id, 'sepa_debit');

    if (card || sepa) {
      let data = {};
      if (sepa.data?.[0]) {
        data.sepa_debit = {
          brand: 'sepa_debit',
          last4: sepa.data[0].sepa_debit.last4,
          name: sepa.data[0].billing_details?.name,
          prefer_payment_method: customer.invoice_settings.default_payment_method === sepa.data[0].id
        }
      }
      if (card) {
        data.card = {
          brand: card.brand,
          last4: card.last4,
          exp_month: card.exp_month,
          exp_year: card.exp_year,
          name: card.name,
          prefer_payment_method: customer.invoice_settings.default_payment_method ? customer.invoice_settings.default_payment_method === card.id : true
        }
      }
      data.address = {
        city: customer.address?.city || '',
        country: customer.address?.country || '',
        street: customer.address?.line1 || '',
        state: customer.address?.state || '',
        state_2: customer.address?.postal_code || '',
      }
      data.invoice_recipient = customer.name
      data.email = customer.email

      return res.status(200).send({ data });
    }
    else {

      return res.status(200).send({ data: null });

    }
  }

  return res.status(200).send({ data: null });

}

/*
* account.card.update()
* update credit card details
*/

exports.card.update = async function (req, res) {

  utility.validate(req.body);

  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__('account.invalid'));

  if (!accountData.stripe_customer_id) {
    utility.assert(req.body.token, res.__('account.card.missing'), 'token');
  }

  const customer = req.body.token?.id && await stripe.customer.update({ id: accountData.stripe_customer_id, token: req.body.token.id });

  const getCustomer = await stripe.customer(accountData.stripe_customer_id);
  card = getCustomer.sources?.data?.[0];

  if (req.body.section === 'payment_method') {
    const customerSource = await stripe.updateSource(
      accountData.stripe_customer_id,
      card.id,
      {
        name: req.body.credit_card_name,
      },
      req.body.prefer_payment_method
    )
    // notify the user
    const send = await notification.get({ account: accountData.id, name: 'card_updated' });

    if (send) {
      await mail.send({

        to: accountData.owner_email,
        locale: req.locale,
        custom: true,
        template: 'card_updated',
        content: { name: accountData.owner_name }

      });
    }
  } else if (req.body.section === 'email') {
    const updateEmail = await stripe.customer.updateEmail({ id: accountData.stripe_customer_id, email: req.body.email })
  } else if (req.body.section === 'invoice_recipient') {
    const updateName = await stripe.customer.updateName({ id: accountData.stripe_customer_id, name: req.body.invoice_recipient })
  } else if (req.body.section === 'address') {
    const customerAddress = await stripe.updateAddress(
      accountData.stripe_customer_id,
      {
        city: req.body.city,
        country: req.body.country,
        line1: req.body.street,
        state: req.body.state,
        postal_code: req.body.state_2,
      }
    )
  }

  return res.status(200).send({

    data: customer?.sources?.data?.[0],
    message: res.__('account.card.updated')

  });
};

/*
* registerParticipant.successPayment()
* attach sepa payment to customer
*/

exports.successPayment = async function (req, res) {
  // utility.validate(req.body);
  utility.assert(req.body.transaction, res.__("account.invalid"));
  const accountData = await account.get({ id: req.account });
  utility.assert(accountData, res.__("account.invalid"));

  if (!accountData.stripe_customer_id) {
    utility.assert(
      accountData.stripe_customer_id,
      res.__("account.sepa.missing")
    );
  }

  const transactionUser = await transaction.findOneAndUpdate(
    { id: new mongoose.Types.ObjectId(req.body.transaction) },
    {
      status: "paid",
    }
  );

  const eventUser = await event.getById({
    id: new mongoose.Types.ObjectId(transactionUser.event_id),
  });

  if (transactionUser && eventUser) {
    const mainUser = await registeredParticipant.findOneAndUpdate(
      { id: new mongoose.Types.ObjectId(transactionUser.participant_id) },
      {
        status: "registered",
      }
    );

    // Delete waiting list participant

    await Waitlist.findOneAndDelete({
      participant_id: new mongoose.Types.ObjectId(transactionUser.participant_id),
      event_id: new mongoose.Types.ObjectId(transactionUser.event_id),
    })

    const mainUserUpdated = await user.update({
      id: req.user,
      account: req.account,
      data: {
        onboarded: true,
      },
    });

    // send email
    await mail.send({
      to: mainUser.email,
      locale: req.locale,
      custom: true,
      template: "event_registered",
      subject: `${eventUser.city.name} - ${res.__(
        "payment.registered_event.subject"
      )}`,
      content: {
        name: `${mainUser.first_name} ${mainUser.last_name}`,
        body: res.__("payment.registered_event.body", {
          name: eventUser.city.name,
          event: eventUser.city.name,
          date: utility.formatDateString(eventUser.date || new Date()),
        }),
        button_url: process.env.CLIENT_URL,
        button_label: res.__("payment.registered_event.button"),
      },
    });

    const data =
      transactionUser?.sub_participant_id &&
      Array.isArray(transactionUser?.sub_participant_id) &&
      (await Promise.all(
        transactionUser.sub_participant_id?.map(async (idSub) => {
          const subUser = await registeredParticipant.findOneAndUpdate(
            { id: new mongoose.Types.ObjectId(idSub) },
            {
              status: "registered",
            }
          );
          // send email
          await mail.send({
            to: subUser.email,
            locale: req.locale,
            custom: true,
            template: "event_registered",
            subject: `${eventUser.city.name} - ${res.__(
              "payment.registered_event.subject"
            )}`,
            content: {
              name: `${subUser.first_name} ${subUser.last_name}`,
              body: res.__("payment.registered_event.body", {
                name: eventUser.city.name,
                event: eventUser.city.name,
                date: utility.formatDateString(eventUser.date || new Date()),
              }),
              button_url: process.env.CLIENT_URL,
              button_label: res.__("payment.registered_event.button"),
            },
          });
          const existed = await user.get({ email: subUser.email });

          if (existed) {
            const accountData = await account.create();
            // const hash = await user.password({ id: subUser.id, account: accountData.id });
            const currentUser = await user.update({
              _id: new mongoose.Types.ObjectId(existed._id),
              data: {
                account: [
                  {
                    id: accountData.id,
                    permission: "owner",
                    onboarded: false,
                  },
                ],
                default_account: accountData.id,
              },
            });

            const token = await auth.token({
              data: { timestamp: Date.now(), user_id: existed.id },
              secret: process.env.TOKEN_SECRET,
              duration: 7200000000,
            });

            await mail.send({
              to: subUser.email,
              locale: req.locale,
              custom: true,
              template: "join_meetlocal",
              subject: `${res.__("payment.join_meetlocal.subject")}`,
              content: {
                name: `${subUser.first_name} ${subUser.last_name}`,
                body: res.__("payment.join_meetlocal.body", {
                  name: eventUser.city.name,
                  event: eventUser.city.name,
                  date: utility.formatDateString(eventUser.date || new Date()),
                }),
                button_url: `${process.env.CLIENT_URL}/resetpassword?token=${token}`,
                button_label: res.__("payment.join_meetlocal.button"),
              },
            });
          }
          return { ...subUser };
        })
      ));

    // Check capacity and send warning email after all participants are registered
    const currentRegistrations = await RegisteredParticipant.countDocuments({
      event_id: transactionUser.event_id,
      status: "registered",
    });

    const totalCapacity = eventUser.bars.reduce(
      (sum, bar) => sum + bar.available_spots,
      0
    );

    if (
      currentRegistrations >= totalCapacity * 0.9 &&
      !eventUser.capacity_warning_sent
    ) {

      try {
        // Get all admin accounts (accounts with name "Master")
        const adminAccounts = await mongoose.model("Account").find({
          name: "Master",
          active: true
        }).select('id').lean();

        console.log(`📧 Found ${adminAccounts.length} admin accounts:`, adminAccounts.map(acc => acc.id));

        // Get all admin users (users whose default_account matches admin account IDs)
        const adminUserIds = adminAccounts.map(account => account.id);
        const adminUsers = await mongoose.model("User").find({
          default_account: { $in: adminUserIds }
        }).select('email name').lean();

        console.log(`👥 Found ${adminUsers.length} admin users:`, adminUsers.map(user => ({ email: user.email, name: user.name })));

        // Send email to all admin users
        for (const adminUser of adminUsers) {
          console.log(`📤 Sending email to: ${adminUser.email} (${adminUser.name || 'Admin'})`);

          const emailData = {
            to: adminUser.email,
            template: "event_registered",
            subject: `🚨 Event Capacity Warning - ${eventUser.tagline}`,
            custom: true,
            content: {
              name: adminUser.name || "Admin",
              body: `
                <h2 style="color: #e74c3c; margin-bottom: 20px;">⚠️ Event Capacity Warning</h2>
                <p style="margin-bottom: 15px;"><strong>Event Details:</strong></p>
                <ul style="margin-bottom: 20px; padding-left: 20px;">
                  <li><strong>Event:</strong> ${eventUser.tagline}</li>
                  <li><strong>Date:</strong> ${new Date(
                eventUser.date
              ).toLocaleDateString()}</li>
                  <li><strong>Time:</strong> ${eventUser.start_time} - ${eventUser.end_time
                }</li>
                  <li><strong>City:</strong> ${eventUser.city.name}</li>
                  <li><strong>Current Registrations:</strong> ${currentRegistrations}</li>
                  <li><strong>Total Capacity:</strong> ${totalCapacity}</li>
                  <li><strong>Available Spots:</strong> ${totalCapacity - currentRegistrations
                }</li>
                  <li><strong>Capacity Percentage:</strong> ${Math.round(
                  (currentRegistrations / totalCapacity) * 100
                )}%</li>
                </ul>
                <p style="margin-bottom: 15px;"><strong>Bar Details:</strong></p>
                <ul style="margin-bottom: 20px; padding-left: 20px;">
                  ${eventUser.bars
                  .map(
                    (bar) => `
                    <li><strong>${bar._id.name}:</strong> ${bar.available_spots} spots available</li>
                  `
                  )
                  .join("")}
                </ul>
                <p style="color: #e74c3c; font-weight: bold; margin-bottom: 20px;">
                  ⚠️ This event has reached 90% capacity! Consider taking action to manage registrations.
                </p>
                <p style="margin-bottom: 20px;">
                  <strong>Action Required:</strong> Monitor registration activity closely. The event may reach full capacity soon.
                </p>
              `,
              button_url: `${process.env.MISSION_CONTROL_CLIENT}/event-management`,
              button_label: "View Event Dashboard",
            },
          };

          await mail.send(emailData);
          console.log(`✅ Email sent successfully to: ${adminUser.email}`);
        }

        await mongoose
          .model("EventManagement")
          .findByIdAndUpdate(transactionUser.event_id, { capacity_warning_sent: true });
      } catch (emailError) {
        console.error("❌ EMAIL SEND FAILED:", emailError);
      }
    } else {
      if (currentRegistrations >= totalCapacity * 0.9) {
        console.log("ℹ️ 90% reached but warning already sent");
      } else {
        console.log("ℹ️ Not yet at 90% capacity");
      }
    }
  }

  return res.status(200).send({
    data: {},
    message: res.__("account.sepa.updated"),
  });
};

/*
 * registerParticipant.cancel()
 */
exports.cancel = async function (req, res) {
  try {
    const idUser = req.user;
    const eventId = req.params.id;
    utility.assert(eventId, res.__('account.invalid'));

    const userData = await user.get({ id: idUser });
    utility.assert(userData, res.__('account.invalid'));

    const eventIdObj = new mongoose.Types.ObjectId(eventId);
    const userIdObj = new mongoose.Types.ObjectId(userData._id);

    const registration = await RegisteredParticipant.findOne({
      user_id: userIdObj,
      event_id: eventIdObj,
      status: 'registered',
    });
    utility.assert(registration, res.__('event.invalid'));

    // Get event details
    const eventData = await event.getById({ id: eventIdObj });
    utility.assert(eventData, res.__('event.invalid'));
    // Compute event start in Europe/Berlin timezone robustly (handles "HH:MM - HH:MM")
    const moment = require('moment-timezone');
    const timeStr = String(eventData.start_time || '00:00');
    const match = timeStr.match(/(\d{1,2}):(\d{2})/);
    const startHour = match ? parseInt(match[1], 10) : 0;
    const startMinute = match ? parseInt(match[2], 10) : 0;
    const eventDateBerlin = moment.tz(eventData.date, 'Europe/Berlin');
    const eventStart = eventDateBerlin.clone().hour(startHour).minute(startMinute).second(0).millisecond(0);
    const now = moment.tz('Europe/Berlin');

    const hoursDiff = eventStart.diff(now, 'hours', true); // floating point hours
    const timely = hoursDiff > 24; // More than 24 hours before start

    // Cancel the registration
    await RegisteredParticipant.findOneAndUpdate(
      {
        _id: registration._id
      },
      {
        status: 'canceled',
        is_cancelled: true,
        cancel_date: new Date()
      },
      { new: true }
    );

    void sendEventAvailabilityMailToWaitlist(registration, res).catch(console.error);

    let voucher = null;
    if (timely) {
      try {
        // Generate a single-use coupon valid for 24 months
        const expiresAt = moment().add(24, 'months');
        const redeemBy = Math.floor(expiresAt.valueOf() / 1000);

        // Determine per-person amount paid by the user for this event
        const Transaction = mongoose.model('Transaction');
        const tx = await Transaction.findOne({
          user_id: new mongoose.Types.ObjectId(userData._id),
          event_id: new mongoose.Types.ObjectId(eventId),
          status: 'paid',
          type: 'Register Event'
        }).lean();

        // If the transaction covered multiple participants (invited friend),
        // only refund this user's share (per-person portion)
        const participantsInTx = 1 + (Array.isArray(tx?.sub_participant_id) ? tx.sub_participant_id.length : 0);
        const perPersonCents = (typeof tx?.amount === 'number')
          ? Math.round((tx.amount * 100) / Math.max(participantsInTx, 1))
          : 0;
        const amountOffCents = perPersonCents;
        if (!amountOffCents || amountOffCents <= 0) {
          throw new Error('No paid transaction found for voucher calculation');
        }
        // Create amount-based coupon equal to what user paid
        const coupon = await stripe.coupon.createOnce({
          amount_off: amountOffCents,
          currency: 'eur',
          redeem_by: redeemBy,
          name: `Voucher - ${eventData.tagline}`,
          metadata: { user_id: String(userData._id), event_id: String(eventId), reason: 'timely_cancellation' }
        });

        // Create a promotion code linked to coupon
        const code = `MEET-${Math.random().toString(36).substring(2, 10).toUpperCase()}`;
        const promo = await stripe.promotionCode.create({
          coupon: coupon.id,
          code,
          expires_at: redeemBy,
          max_redemptions: 1,
          metadata: { user_id: String(userData._id), event_id: String(eventId), coupon_id: coupon.id }
        });

        voucher = { code: promo.code, expires_at: expiresAt.toISOString() };
      } catch (e) {
        console.error('Voucher creation failed:', e);
      }
    }

    // Send email
    try {
      const isTimely = Boolean(voucher);
      const subject = isTimely ? res.__('payment.cancelled_event.subject_personal', { city: eventData.city?.name }) : res.__('payment.cancelled_event_late.subject_personal', { city: eventData.city?.name });
      const body = isTimely
        ? res.__('payment.cancelled_event.body_personal', { event: eventData.tagline, code: voucher.code, date: moment(voucher.expires_at).format('YYYY-MM-DD') })
        : res.__('payment.cancelled_event_late.body_personal', { event: eventData.tagline });

      await mail.send({
        to: registration.email,
        locale: req.locale,
        custom: true,
        template: 'event_cancelled',
        subject,
        content: {
          name: `${registration.first_name} ${registration.last_name}`,
          body,
          button_url: process.env.CLIENT_URL,
          button_label: 'View Events'
        }
      });
    } catch (e) {
      console.error('Cancel email failed:', e);
    }

    return res.status(200).send({ data: { canceled: true, voucher } });
  } catch (err) {
    console.log(err);
    return res.status(500).send({ error: err.message });
  }
};
