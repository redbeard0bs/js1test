import { models } from '../models'
import { loadLightning } from '../utils/lightning'
import * as socket from '../utils/socket'
import * as jsonUtils from '../utils/json'
import * as decodeUtils from '../utils/decode'
import * as helpers from '../helpers'
import { sendNotification } from '../hub'
import { success } from '../utils/res'
import {sendConfirmation} from './confirmations'

const constants = require(__dirname + '/../../config/constants.json');

const payInvoice = async (req, res) => {
  const lightning = await loadLightning()
  const { payment_request } = req.body;

  var call = lightning.sendPayment({})

  call.on('data', async response => {
    console.log('[pay invoice data]', response)

    const message = await models.Message.findOne({ where: { payment_request } })
    if (!message) { // invoice still paid
      return success(res, {
        success: true,
        response: { payment_request }
      })
    }

    message.status = constants.statuses.confirmed;
    message.save();

    var date = new Date();
    date.setMilliseconds(0)

    const chat = await models.Chat.findOne({ where: { id: message.chatId } })
    const contactIds = JSON.parse(chat.contactIds)
    const senderId = contactIds.find(id => id != message.sender)

    const paidMessage = await models.Message.create({
      chatId: message.chatId,
      sender: senderId,
      type: constants.message_types.payment,
      amount: message.amount,
      amountMsat: message.amountMsat,
      paymentHash: message.paymentHash,
      date: date,
      expirationDate: null,
      messageContent: null,
      status: constants.statuses.confirmed,
      createdAt: date,
      updatedAt: date
    })
    console.log('[pay invoice] stored message', paidMessage)
    success(res, jsonUtils.messageToJson(paidMessage, chat))
  })

  call.write({ payment_request })
};


const cancelInvoice = (req, res) => {
  res.status(200);
  res.json({ success: false });
  res.end();
};

const createInvoice = async (req, res) => {
  const lightning = await loadLightning()

  const {
    amount,
    memo,
    remote_memo,
    chat_id,
    contact_id
  } = req.body;

  var request = {
    value: amount,
    memo: remote_memo || memo
  }

  if (amount == null) {
    res.status(200);
    res.json({ err: "no amount specified", });
    res.end();
  } else {
    lightning.addInvoice(request, function (err, response) {
      console.log({ err, response })

      if (err == null) {
        const { payment_request } = response

        if (!contact_id && !chat_id) { // if no contact
          success(res, {
            invoice: payment_request
          })
          return // end here
        }

        lightning.decodePayReq({ pay_req: payment_request }, async (error, invoice) => {
          if (res) {
            console.log('decoded pay req', { invoice })

            const owner = await models.Contact.findOne({ where: { isOwner: true } })

            const chat = await helpers.findOrCreateChat({
              chat_id,
              owner_id: owner.id,
              recipient_id: contact_id
            })

            let timestamp = parseInt(invoice.timestamp + '000')
            let expiry = parseInt(invoice.expiry + '000')

            if (error) {
              res.status(200)
              res.json({ success: false, error })
              res.end()
            } else {
              const message = await models.Message.create({
                chatId: chat.id,
                sender: owner.id,
                type: constants.message_types.invoice,
                amount: parseInt(invoice.num_satoshis),
                amountMsat: parseInt(invoice.num_satoshis) * 1000,
                paymentHash: invoice.payment_hash,
                paymentRequest: payment_request,
                date: new Date(timestamp),
                expirationDate: new Date(timestamp + expiry),
                messageContent: memo,
                remoteMessageContent: remote_memo,
                status: constants.statuses.pending,
                createdAt: new Date(timestamp),
                updatedAt: new Date(timestamp)
              })
              success(res, jsonUtils.messageToJson(message, chat))

              helpers.sendMessage({
                chat: chat,
                sender: owner,
                type: constants.message_types.invoice,
                message: {
                  id: message.id,
                  invoice: message.paymentRequest
                }
              })
            }
          } else {
            console.log('error decoding pay req', { err, res })
            res.status(500);
            res.json({ err, res })
            res.end();
          }
        })
      } else {
        console.log({ err, response })
      }
    });
  }
};

const listInvoices = async (req, res) => {
  const lightning = await loadLightning()

  lightning.listInvoices({}, (err, response) => {
    console.log({ err, response })
    if (err == null) {
      res.status(200);
      res.json(response);
      res.end();
    } else {
      console.log({ err, response })
    }
  });
};

const receiveInvoice = async (payload) => {
  console.log('received invoice', payload)

  const total_spent = 1
  const dat = payload.content || payload
  const payment_request = dat.message.invoice
  var date = new Date();
  date.setMilliseconds(0)

  const { owner, sender, chat, msg_id } = await helpers.parseReceiveParams(payload)
  if (!owner || !sender || !chat) {
    return console.log('=> no group chat!')
  }

  const { memo, sat, msat, paymentHash, invoiceDate, expirationSeconds } = decodePaymentRequest(payment_request)

  const message = await models.Message.create({
    chatId: chat.id,
    type: constants.message_types.invoice,
    sender: sender.id,
    amount: sat,
    amountMsat: msat,
    paymentRequest: payment_request,
    asciiEncodedTotal: total_spent,
    paymentHash: paymentHash,
    messageContent: memo,
    expirationDate: new Date(invoiceDate + expirationSeconds),
    date: new Date(invoiceDate),
    status: constants.statuses.pending,
    createdAt: date,
    updatedAt: date
  })
  console.log('received keysend invoice message', message.id)

  socket.sendJson({
    type: 'invoice',
    response: jsonUtils.messageToJson(message, chat)
  })

  sendNotification(chat, sender.alias, 'message')

  const theChat = {...chat.dataValues, contactIds:[sender.id]}
  sendConfirmation({ chat:theChat, sender: owner, msg_id })
}

export {
  listInvoices,
  payInvoice,
  cancelInvoice,
  createInvoice,
  receiveInvoice
}

// lnd invoice stuff

function decodePaymentRequest(paymentRequest) {
  var decodedPaymentRequest: any = decodeUtils.decode(paymentRequest)
  var expirationSeconds = 3600
  var paymentHash = ""
  var memo = ""

  for (var i = 0; i < decodedPaymentRequest.data.tags.length; i++) {
    let tag = decodedPaymentRequest.data.tags[i];
    if(tag) {
      if (tag.description == 'payment_hash') {
        paymentHash = tag.value;
      } else if (tag.description == 'description') {
        memo = tag.value;
      } else if (tag.description == 'expiry') {
        expirationSeconds = tag.value;
      }
    }
  }

  expirationSeconds = parseInt(expirationSeconds.toString() + '000');
  let invoiceDate = parseInt(decodedPaymentRequest.data.time_stamp.toString() + '000');

  let amount = decodedPaymentRequest['human_readable_part']['amount'];
  var msat = 0;
  var sat = 0;
  if (Number.isInteger(amount)) {
    msat = amount;
    sat = amount / 1000;
  }

  return { sat, msat, paymentHash, invoiceDate, expirationSeconds, memo }
}
