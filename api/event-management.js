const express = require('express');
const auth = require('../model/auth');
const eventManagementController = require('../controller/eventManagementController');
const registeredParticipantController = require('../controller/registerParticipantController');
const api = express.Router();
const couponController = require('../controller/couponController');
const use = require('../helper/utility').use;
const cors = require('cors');

api.get('/api/events', auth.verify('user'), use(eventManagementController.get));

api.get('/api/public-events', cors(), use(eventManagementController.getPublicEvents));

api.get('/api/events/matching', auth.verify('user'), use(eventManagementController.getMatchingEvents));

api.get('/api/events/dashboard', auth.verify('user'), use(eventManagementController.dashboard));

api.post('/api/events/register', auth.verify('owner'), use(registeredParticipantController.create));


api.post('/api/event/payment/:id', auth.verify('user'), use(registeredParticipantController.pay));

// Validate promotion code and preview discount amount for event payment
api.post('/api/event/:id/validate-coupon', auth.verify('user'), use(couponController.validateEventCoupon));

api.post('/api/sepa-attach', auth.verify('user'), use(registeredParticipantController.sepa.attach));

api.post('/api/event/success', auth.verify('user'), use(registeredParticipantController.successPayment));

api.post('/api/events/:id/cancel', auth.verify('user'), use(registeredParticipantController.cancel));

api.get('/api/events/:id', auth.verify('user'), use(eventManagementController.getById));
// Admin cancellations: entire event, group, or team
// Removed admin routes; admin logic is implemented in meet-mission service

module.exports = api;
