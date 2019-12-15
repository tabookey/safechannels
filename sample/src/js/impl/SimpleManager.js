import TruffleContract from '@truffle/contract'
/* global error */
import SmartAccountFactoryABI from 'safechannels-contracts/src/js/generated/SmartAccountFactory'
import FactoryContractInteractor from 'safechannels-contracts/src/js/FactoryContractInteractor'

import SimpleWallet from './SimpleWallet'
import SimpleManagerApi from '../api/SimpleManager.api.js'

// API of the main factory object.
export default class SimpleManager extends SimpleManagerApi {
  constructor ({ accountApi, backend, factoryConfig }) {
    super()
    this.accountApi = accountApi
    this.backend = backend
    this.factoryConfig = this._validateConfig(factoryConfig)
  }

  getEmail () {
    return this.accountApi.getEmail()
  }

  async googleLogin () {
    return this.accountApi.googleLogin()
  }

  async googleAuthenticate () {
    return this.accountApi.googleAuthenticate()
  }

  async signOut () {
    this.accountApi.signout()
  }

  getOwner () {
    return this.accountApi.getOwner()
  }

  async validatePhone ({ jwt, phone }) {
    const response = await this.backend.validatePhone({ jwt, phone })
    if (response.code === 200) {
      return { success: true, reason: null }
    } else {
      return { success: false, reason: response.error }
    }
  }

  async getWalletAddress () {
    if (await this.hasWallet()) {
      return this.wallet.address
    }

    return null
  }

  async hasWallet () {
    return this.wallet != null
  }

  async loadWallet () {
  }

  async recoverWallet ({ owner, email }) {
    error('trigger recover flow')
  }

  /**
   * Actual blockchain communication will be moved to the interaction layer later
   */
  async _initializeFactory ({ factoryAddress, provider }) {
    const SmartAccountFactoryContract = TruffleContract({
      contractName: 'SmartAccountFactory',
      abi: SmartAccountFactoryABI
    })
    SmartAccountFactoryContract.setProvider(provider)
    this.smartAccountFactory = await SmartAccountFactoryContract.at(factoryAddress)
  }

  async createWallet ({ jwt, phone, smsVerificationCode }) {
    if (!jwt || !phone || !smsVerificationCode) {
      throw Error('All parameters are required')
    }
    if (this.smartAccountFactory === undefined) {
      await this._initializeFactory(this.factoryConfig)
    }
    const response = await this.backend.createAccount({ jwt: jwt, phoneNumber: phone, smsCode: smsVerificationCode })

    const sender = this.getOwner()
    // TODO: next commit: make 'FactoryContractInteractor.deployNewSmartAccount' do this job
    const smartAccountIdId = response.smartAccountId
    const approvalData = response.approvalData
    const receipt = await this.smartAccountFactory.newSmartAccount(smartAccountIdId, {
      from: sender,
      gas: 1e8,
      approvalData: approvalData
    })
    const smartAccount = await FactoryContractInteractor.getCreatedSmartAccount(
      {
        factoryAddress: this.factoryConfig.factoryAddress,
        sender: sender,
        // TODO: just pass the event from the receipt!
        blockNumber: receipt.blockNumber,
        provider: this.factoryConfig.provider
      })
    return new SimpleWallet({ contract: smartAccount, participant: {}, knownParticipants: [] })
  }

  _validateConfig (factoryConfig) {
    // TODO: check all needed fields of config
    return factoryConfig
  }

  async addDeviceNow ({ jwt, description }) {
    super.addDeviceNow({ jwt, description })
  }
}
