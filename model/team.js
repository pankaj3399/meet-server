const mongoose = require('mongoose');
const { Schema } = mongoose;

const TeamSchema = new Schema({
  event_id: { type: Schema.Types.ObjectId, ref: 'EventManagement', required: true },
  age_group: { type: String, enum: ['18-30', '31-40', '41+'], required: true },
  members: [
    {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    }
  ],
  method: { type: String, default: 'assigned by AI' }
}, { timestamps: true });

const Team = mongoose.model('Team', TeamSchema, 'teams');
exports.schema = Team;

/*
* team.add()
*/
exports.add = async function ({ team, eventId }) {
  const data = new Team({
    event_id: new mongoose.Types.ObjectId(eventId),
    age_group: team.age_group,
    members: team.members.map(member => new mongoose.Types.ObjectId(member.user_id)),
    ...team.method && { method: team.method }
  });

  return await data.save();
};

/*
* team.update()
*/
exports.update = async function ({ team, eventId, id }) {
  const data = await Team.findOneAndUpdate({ _id: new mongoose.Types.ObjectId(id) }, {
    event_id: new mongoose.Types.ObjectId(eventId),
    ...team.age_group && { age_group: team.age_group},
    ...team.members && { members: team.members.map(member => new mongoose.Types.ObjectId(member.id)) },
    method: 'assigned by Admin'
  }, { new: true });

  return data;
};

/*
* team.get()
*/
exports.get = async function ({ eventId }) {
  const data = await Team.find({
    event_id: new mongoose.Types.ObjectId(eventId)})
    .populate({
        path: 'members',
        select: 'name first_name last_name'
    }).sort({ createdAt: -1});
  return data;
};

/*
* team.getById()
*/
exports.getById = async function ({ id }) {
  const data = await Team.find({
    _id: new mongoose.Types.ObjectId(id)})
    .populate({
        path: 'members',
        select: 'name first_name last_name'
    });
  return data;
};

/*
* team.getByUserId()
*/
exports.getByUserId = async function ({ id }) {
  const data = await Team.findOne({
    members: new mongoose.Types.ObjectId(id)
  }).populate({
    path: 'members',
    select: 'name first_name last_name locale'
  });

  return data;
};

/*
* team.delete()
*/
exports.delete = async function ({ id }) {
  if (!id) throw { message: 'Please provide an event ID' };
  await Team.deleteOne({ _id: id });
  return id;
};