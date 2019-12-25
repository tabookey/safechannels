import Web3 from 'web3'
import crypto from 'crypto'
// import FactoryContractInteractor from 'safechannels-contracts/src/js/FactoryContractInteractor'
import Permissions from 'safechannels-contracts/src/js/Permissions'
import scutils from 'safechannels-contracts/src/js/SafeChannelUtils'
import abiDecoder from 'abi-decoder'
import SmartAccountFactoryABI from 'safechannels-contracts/src/js/generated/SmartAccountFactory'
import SmartAccountABI from 'safechannels-contracts/src/js/generated/SmartAccount'

export class Watchdog {
  constructor ({ smsManager, keyManager, accountManager, smartAccountFactoryAddress, sponsorAddress, web3provider }) {
    Object.assign(this, {
      smsManager,
      keyManager,
      accountManager,
      smartAccountFactoryAddress,
      sponsorAddress,
      web3provider,
      web3: new Web3(web3provider),
      secretSMSCodeSeed: crypto.randomBytes(32)
    })
    abiDecoder.addABI(SmartAccountFactoryABI)
    abiDecoder.addABI(SmartAccountABI)
    this.permsLevel = scutils.packPermissionLevel(Permissions.WatchdogPermissions, 1)
    this.address = keyManager.address()
    this.smartAccountContract = new this.web3.eth.Contract(SmartAccountABI, '')
    this.smartAccountFactoryContract = new this.web3.eth.Contract(SmartAccountFactoryABI, smartAccountFactoryAddress)
    const smartAccountTopics = Object.keys(this.smartAccountContract.events).filter(x => (x.includes('0x')))
    const smartAccountFactoryTopics = Object.keys(this.smartAccountFactoryContract.events).filter(
      x => (x.includes('0x')))
    this.topics = smartAccountTopics.concat(smartAccountFactoryTopics)
    this.lastScannedBlock = 0
    this.changesToApply = {}
  }

  async start () {
    console.log('Subscribing to new blocks')
    this.subscription = this.web3.eth.subscribe('newBlockHeaders', function (error, result) {
      if (error) {
        console.error(error)
      }
    }).on('data', this._worker.bind(this)).on('error', console.error)
  }

  async stop () {
    this.subscription.unsubscribe(function (error, success) {
      if (success) {
        console.log('Successfully unsubscribed!')
      } else if (error) {
        throw error
      }
    })
  }

  async _worker (blockHeader) {
    const options = {
      fromBlock: this.lastScannedBlock,
      toBlock: 'latest',
      topics: [this.topics]
    }
    const logs = await this.web3.eth.getPastLogs(options)
    const decodedLogs = abiDecoder.decodeLogs(logs).map(this._parseEvent)

    for (const dlog of decodedLogs) {
      switch (dlog.name) {
        case 'SmartAccountCreated':
          await this._handleSmartAccountCreatedEvent(dlog)
          break
        case 'ConfigPending':
        case 'BypassCallPending':
          await this._handlePendingEvent(dlog)
          break
        case 'ConfigCancelled':
        case 'BypassCallCancelled':
        case 'ConfigApplied':
        case 'BypassCallApplied':
          await this._handleCancelledOrAppliedEvent(dlog)
          break
      }
    }
    await this._applyChanges()
    this.lastScannedBlock = logs[logs.length - 1].blockNumber
  }

  async _handleSmartAccountCreatedEvent (dlog) {
    const account = this.accountManager.getAccountById({ accountId: dlog.args.smartAccountId })
    if (!account || this.smartAccountFactoryAddress !== dlog.address) {
      return
    }
    account.address = dlog.args.smartAccount
    this.accountManager.putAccount({ account })
  }

  async _handlePendingEvent (dlog) {
    const account = this.accountManager.getAccountByAddress({ address: dlog.address })
    if (!account) {
      return
    }
    const smsCode = this.smsManager.getSmsCode({ phoneNumber: account.phone, email: account.email })
    const delayedOpId = dlog.args.delayedOpId
    await this.smsManager.sendSMS({
      phoneNumber: account.phone,
      message: `To cancel event ${delayedOpId} on smartAccount ${account.address}, enter code ${smsCode}`
    })
    const dueTime = dlog.args.dueTime * 1000
    this.changesToApply[delayedOpId] = { dueTime: dueTime, log: dlog }
  }

  async _handleCancelledOrAppliedEvent (dlog) {
    const account = this.accountManager.getAccountByAddress({ address: dlog.address })
    if (!account) {
      return
    }
    const delayedOpId = dlog.args.delayedOpId
    delete this.changesToApply[delayedOpId]
  }

  async _applyChanges () {
    for (const delayedOpId of Object.keys(this.changesToApply)) {
      const change = this.changesToApply[delayedOpId]
      if (change.dueTime <= Date.now()) {
        await this._finalizeChange(delayedOpId, { apply: true })
      }
    }
  }

  _extractCancelParamsFromUrl ({ url }) {
    const regex = /To cancel event (0x[0-9a-fA-F]*) on smartAccount (0x[0-9a-fA-F]*), enter code ([0-9]*)/
    const [, delayedOpId, address, smsCode] = url.match(regex)
    return { delayedOpId, address, smsCode }
  }

  async cancelByUrl ({ jwt, url }) {
    const { delayedOpId, address, smsCode } = this._extractCancelParamsFromUrl({ url })
    const account = this.accountManager.getAccountByAddress({ address })
    if (this.smsManager.getSmsCode(
      { phoneNumber: account.phone, email: account.email, expectedSmsCode: smsCode }) === smsCode) {
      return this._finalizeChange(delayedOpId, { cancel: true })
    }
  }

  async _finalizeChange (delayedOpId, { apply, cancel }) {
    if (!apply && !cancel) {
      throw new Error('Please specify apply/cancel')
    }
    const change = this.changesToApply[delayedOpId]
    let method
    let smartAccountMethod
    this.smartAccountContract.options.address = change.log.address
    // TODO we should refactor events and function args to match in naming, and just use '...Object.values(change.log.args)'
    if (change.log.name === 'BypassCallPending') {
      if (apply) {
        smartAccountMethod = this.smartAccountContract.methods.applyBypassCall
      } else if (cancel) {
        smartAccountMethod = this.smartAccountContract.methods.cancelBypassCall
      }
      method = smartAccountMethod(
        this.permsLevel,
        change.log.args.sender,
        change.log.args.senderPermsLevel,
        change.log.args.stateId,
        change.log.args.target,
        change.log.args.value,
        change.log.args.msgdata || Buffer.alloc(0)
      )
    } else if (change.log.name === 'ConfigPending') {
      if (apply) {
        smartAccountMethod = this.smartAccountContract.methods.applyConfig
      } else if (cancel) {
        smartAccountMethod = this.smartAccountContract.methods.cancelOperation
      }
      method = smartAccountMethod(
        this.permsLevel,
        change.log.args.actions,
        change.log.args.actionsArguments1,
        change.log.args.actionsArguments2,
        change.log.args.stateId,
        change.log.args.sender,
        change.log.args.senderPermsLevel,
        change.log.args.booster,
        change.log.args.boosterPermsLevel
      )
    } else {
      throw new Error('Unsupported event' + change.log.name)
    }
    try {
      const receipt = await this._sendTransaction(method, change)
      delete this.changesToApply[delayedOpId]
      return receipt
    } catch (e) {
      console.log(`Got error handling event ${e.message}\nevent ${change.log}`)
    }
  }

  async _sendTransaction (method, change) {
    const encodedCall = method.encodeABI()
    let gasPrice = await this.web3.eth.getGasPrice()
    gasPrice = parseInt(gasPrice)
    const gas = await method.estimateGas({ from: this.keyManager.address() })
    const nonce = await this.web3.eth.getTransactionCount(this.keyManager.address())
    const txToSign = {
      to: change.log.address,
      value: 0,
      gasPrice: gasPrice || 1e9,
      gas: gas,
      data: encodedCall ? Buffer.from(encodedCall.slice(2), 'hex') : Buffer.alloc(0),
      nonce
    }
    const signedTx = this.keyManager.signTransaction(txToSign)
    const receipt = await this.web3.eth.sendSignedTransaction(signedTx)
    console.log('\ntxhash is', receipt.transactionHash)
    return receipt
  }

  _parseEvent (event) {
    if (!event || !event.events) {
      return 'not event: ' + event
    }
    const args = {}
    // event arguments is for some weird reason give as ".events"
    for (const eventArgument of event.events) {
      args[eventArgument.name] = eventArgument.value
    }
    return {
      name: event.name,
      address: event.address,
      args: args
    }
  }

  async getAddresses () {
    return {
      watchdog: this.keyManager.address(),
      admin: this.keyManager.address(),
      factory: this.smartAccountFactoryAddress,
      sponsor: this.sponsorAddress
    }
  }
}
