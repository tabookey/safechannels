/* global prompt alert */
/* eslint  "react/prop-types":"off"   */

import React, { useState } from 'react'
import './App.css'

import SimpleManagerMock from '../js/mocks/SimpleManager.mock'
import Web3 from 'web3'
import ClientBackend from '../js/backend/ClientBackend'
import SmartAccountSDK from '../js/impl/SmartAccountSDK'
import SimpleManager from '../js/impl/SimpleManager'
import { increaseTime } from './GanacheIncreaseTime'
import { toBN } from 'web3-utils'
import AccountMock from '../js/mocks/Account.mock'
import SimpleWallet from '../js/impl/SimpleWallet'

let debug = getParam('debug')

function getParam (name) {
  const params = window.location.href.replace(/^.*#/, '')
  return params.indexOf(name) >= 0
}

// mock initialization:
const useMock = window.location.href.indexOf('#mock') > 0
const verbose = window.location.href.indexOf('#verbose') > 0

var mgr, sms, wallet, sdk
const Button = ({ title, action }) => <input type="submit" onClick={action} value={title}/>

function errorStr (e) {
  if (e.stack) return 'stk:' + e.stack
  if (e.message) return 'msg:' + e.message
  if (e.error) return 'err:' + e.error
  return JSON.stringify(e)
}

// not directly belongs to the UI - but extract device name from userAgent..
function getDeviceName () {
  const userAgent = global.navigator && (navigator.userAgent || 'unknown')
  const deviceMatch = userAgent.match(/\((.*?)\)/)
  if (!deviceMatch) { return userAgent }

  const names = deviceMatch[1].split(/\s*;\s*/)
  // TODO: Android is 2nd best: should return specific device type - if known.
  const ret = names.find(name => /Window|Mac|iP|Android|Pixel|SM-|Nexus/.test(name))
  return ret || deviceMatch
}

function GoogleLogin ({ refresh, initMgr }) {
  async function login () {
    try {
      await initMgr()
      const logininfo = await mgr.googleLogin()
      if (!logininfo || !logininfo.email) {
        return
      }
      const { jwt, email } = logininfo
      refresh({ jwt, email })
    } catch (e) {
      refresh({ err: errorStr(e) })
    }
  }

  return <div>
    Youre not logged in
    <Button title="click to login" action={login}/>
  </div>
}

function CreateWallet ({ refresh, jwt, email, userConfig, setUserConfig }) {
  let phoneNumber

  const [initConfig, setInitConfig] = useState('')
  const [delayTime, setDelayTime] = useState('1m')
  const [delayErr, setDelayErr] = useState('')

  const startCreate = async () => {
    const PHONE = '+972541234567'

    phoneNumber = prompt('enter phone number to validate ( put 1 for "' + PHONE + '" )')
    if (!phoneNumber) {
      return
    }
    // local israeli phones...
    phoneNumber = phoneNumber.replace(/^0/, '+972')
    if (phoneNumber === '1') {
      phoneNumber = PHONE
    }
    console.log('validate:', jwt, phoneNumber)
    await mgr.validatePhone({ jwt, phoneNumber })
    window.alert('sms sent. copy SMS code to create wallet')
  }

  const createWallet = async () => {
    const smsVerificationCode = prompt('enter SMS verification code')
    if (!smsVerificationCode) {
      return
    }

    try {
      await mgr.createWallet({ jwt, phoneNumber, smsVerificationCode })
      // TODO: create wallet and initial config
      const wallet = await mgr.loadWallet()
      const initialConfig = await wallet.createInitialConfig({ userConfig })
      await wallet.initialConfiguration(initialConfig)

      refresh({ err: undefined })
    } catch (e) {
      refresh({ err: errorStr(e) })
    }
  }

  function updateWhitelistConfig (val) {
    setInitConfig(val) // for UI leave string as-is
    // modify global state
    userConfig.whitelistPreconfigured = val.split(/[ \t]*[,\n][ \t]*/).filter(addr => !!addr)
    setUserConfig(userConfig)
  }

  function updateDelayTime (val) {
    setDelayTime(val) // for UI leave string as-is
    // modify global state
    try {
      const suffixes = { s: 1, m: 60, h: 3600, d: 86400 }
      const [, t, suf] = val.match(/^\s*([\d.]+)\s*(\w?)/)

      const time = Math.floor(t * (suffixes[suf.toLowerCase()] || 1))
      userConfig.initialDelays[1] = time
      setUserConfig(userConfig)
      setDelayErr('')
    } catch (e) {
      setDelayErr('invalid number/suffix')
      // ignore - just don't display..
    }
  }

  return <div>
    Hello <b>{email}</b>, you dont have a wallet yet.<br/>
    Click <Button title="here to verify phone" action={startCreate}/><br/>
    Click here to enter SMS verification code <Button title="verify and create" action={createWallet}/>

    <p/>
    Enter whitelisted addresses for initial configuration:<br/>
    <textarea cols="80" value={initConfig} onChange={e => updateWhitelistConfig(e.target.value)}></textarea><br/>

    Delay time:
    <input cols="10" value={delayTime} onChange={e => updateDelayTime(e.target.value)}/>
    <span style={{ fontSize: 10 }}>(can use d/h/m/s suffix)
      <span style={{ color: 'red' }}>{delayErr}</span>
    </span><br/>
    <pre>
      {JSON.stringify(userConfig, null, 2)}
    </pre>
  </div>
}

function TokenWidget ({ symbol, balance, decimals, doTransfer }) {
  const div = '1' + '0'.repeat(decimals || 0)
  return <span>{symbol}: {balance / div} <Button title={'send ' + symbol}
    action={() => doTransfer({ symbol })}/><br/></span>
}

const PendingTransaction = ({ p }) => {
  const op = p.operation || (p.operations && p.operations[0] && p.operations[0].type)
  if (op === 'transfer') {
    return <>
      transfer: {p.tokenSymbol} {p.value / 1e18} {p.destination}
    </>
  }

  if (op === 'add_operator') {
    return <>
      add operator: {p.operations[0].args[0].replace(/0x(0*)/, '0x')}
    </>
  }

  return <>
    unknown operation: {JSON.stringify(p)}
  </>
}

const PendingTransactions = ({ walletPending, doCancelPending }) =>
  <div>
    <b>Pending</b>
    {walletPending.map((p, i) =>
      <div key={i}>
        <PendingTransaction p={p}/> -
        <Button title="Cancel" action={() => doCancelPending(p.delayedOpId)}/>
      </div>)
    }
  </div>

const Whitelist = ({ whitelist, doAddToWhiteList, doRemoveFromWhitelist }) => <div>
  <b>Whitelist</b><Button title="+ add" action={doAddToWhiteList}/><br/>
  {(!whitelist || !whitelist.length) && <span style={{ fontSize: 10 }}>No whitelisted addresses</span>}
  {whitelist && whitelist.map(wl => <span key={wl}>{wl} <Button title="remove"
    action={() => doRemoveFromWhitelist(wl)}/><br/></span>)}

</div>

function ActiveWallet ({
  ownerAddr, walletInfo, walletBalances, walletPending, doTransfer, doCancelPending, doOldDeviceApproveOperator,
  whitelist, doAddToWhiteList, doRemoveFromWhitelist,
  pendingAddOperatorNow
}) {
  const info = JSON.stringify(walletInfo, null, 2)
  const pending = JSON.stringify(walletPending, null, 2)

  return <>
    Wallet owner: {ownerAddr}<p/>
    <Button title="Add operator with code" action={doOldDeviceApproveOperator}/><br/>
    <b>Balances</b><br/>
    {
      walletBalances.map(token => <TokenWidget key={token.symbol} {...token} doTransfer={doTransfer}/>)
    }

    <br/>
    <Whitelist whitelist={whitelist} doAddToWhiteList={doAddToWhiteList} doRemoveFromWhitelist={doRemoveFromWhitelist}/>
    {
      walletPending.length ? <PendingTransactions walletPending={walletPending} doCancelPending={doCancelPending}/>
        : <b>No Pending Transactions</b>
    }

    {
      pendingAddOperatorNow && <div>
        Sent an SMS to owner device. Once approved, this device will also become operator.<br/>
        Until then, you can only view this wallet.
      </div>
    }

    {
      !walletInfo.isOperator &&
      <div style={{ color: 'orange' }}>Warning: You are not an owner</div>
    }
    <xmp>
      Pending: {pending}
    </xmp>
    <xmp>
      Wallet Info:
      {info}
    </xmp>
  </>
}

function RecoverOrNewDevice ({ email, doNewDeviceAddOperator, doRecoverWalletOnNewDevice, doValidateRecoverWallet }) {
  return <div>
    Hello <b>{email}</b>,
    You have wallet on-chain, but this device is not its operator.<br/>
    You can either<br/>
    <ul>
      <li><Button title="add new operator" action={doNewDeviceAddOperator}/> (requires approval on your old
        device) or,
      </li>
      <li>Recover your wallet (You dont need your old device, but it takes time)
        <ul>
          <li> Step 1: <Button title="Request recover SMS" action={doRecoverWalletOnNewDevice}/>
          </li>
          <li> Step 2: <Button title="Use SMS to recover" action={doValidateRecoverWallet}/>
          </li>
        </ul>
      </li>
    </ul>
  </div>
}

function DebugState ({ state }) {
  return debug && <>state={state}</>
}

class CancelByUrl extends React.Component {
  constructor (props) {
    super(props)
    this.state = {}
  }

  componentDidMount () {
    this.props.initMgr().then(() => {
      const url = window.location.href
      console.log('xurl=', url)
      mgr.cancelByUrl({ jwt: null, url }).then(() => this.setState({ complete: true })).catch(
        err => this.setState({ err: errorStr(err) }))
    })
  }

  render () {
    const { complete, err } = this.state
    if (complete) {
      return <> <h2>Canceled. </h2>
        <Button title="Close" action={() => window.close()}/>
      </>
    }
    if (err) {
      return <>
        <div style={{ color: 'red' }}>
          <h2>Cancel Failed</h2>
          <pre>{err}</pre>
        </div>
        <Button title="Close" action={() => window.close()}/>
      </>
    }
    return <>Canceling... please wait</>
  }
}

function WalletComponent (options) {
  const { walletAddr, email, ownerAddr, walletInfo, loading, pendingAddOperatorNow } = options

  if (window.location.href.includes('op=cancel')) {
    return <CancelByUrl {...options} />
  }

  if (loading) {
    return <h2>Loading, please wait.</h2>
  }

  if (!email || !ownerAddr) {
    return <><DebugState state="noemail"/><GoogleLogin {...options}/></>
  }
  if (!walletAddr) {
    return <><DebugState state="nowalletAddr"/><CreateWallet {...options} /></>
  }
  // pendingAddOperatorNow is a local flag set after we've sent a request
  // to add this device.
  if (!pendingAddOperatorNow && (!walletInfo || !walletInfo.isOperatorOrPending)) {
    return <><DebugState state="nowalletInfo"/><RecoverOrNewDevice {...options} /></>
  }

  return <ActiveWallet {...options} />
}

class App extends React.Component {
  constructor (props) {
    super(props)
    // manager is initialized (async'ly) from first call to readMgrState

    this.state = { debug, loading: true }
  }

  componentDidMount () {
    this.asyncHandler(this.initMgr())
  }

  // - call promise, update UI (either with good state, or error)
  // TODO: we have subscribe to update on any blockchain change.
  //  is it redundant? (not on error, anyway)
  asyncHandler (promise) {
    return promise.then(() => this.readMgrState().then(x => { this.setState(x) }))
      .catch(err => this.reloadState({ err: errorStr(err) }))
  }

  async readMgrState () {
    console.log('readMgrState')
    const mgrState = {
      loading: undefined,
      userConfig: undefined,
      walletInfo: undefined,
      walletBalances: undefined,
      walletPending: undefined
    }
    if (sdk && await sdk.isEnabled({ appUrl: window.location.href })) {
      // read fields form wallet only once: they can't change (unless we logout)
      Object.assign(mgrState, {
        needApprove: undefined,
        ownerAddr: this.state.ownerAddress || await mgr.getOwner(),
        email: this.state.email || await mgr.getEmail(),
        walletAddr: this.state.walletAddr || await mgr.getWalletAddress()
      })
      if (!mgrState.walletAddr && mgrState.email) {
        mgrState.userConfig = SimpleWallet.getDefaultUserConfig()
      }
      console.log('readMgrState: has some state')
    } else {
      mgrState.needApprove = true
      console.log('not enabled', window.location.href)
    }

    if (mgrState.walletAddr) {
      if (!wallet) {
        wallet = await mgr.loadWallet()
        await wallet.subscribe(() => this.eventSubscriber())
      }
      mgrState.walletInfo = await wallet.getWalletInfo()
      // TODO: isOperator, isOperatorOrPending are just parsers of walletInfo.
      // no need to re-fetch it..
      mgrState.walletInfo.isOperator = await wallet.isOperator(mgrState.ownerAddr)
      mgrState.walletInfo.isOperatorOrPending = await wallet.isOperatorOrPending(mgrState.ownerAddr)
      if (mgrState.walletInfo.isOperator) {
        mgrState.pendingAddOperatorNow = undefined
      }
      mgrState.walletBalances = await wallet.listTokens()
      mgrState.walletPending = [...await wallet.listPendingTransactions(), ...await wallet.listPendingConfigChanges()]
      mgrState.walletPending.forEach((x, index) => { x.index = (index + 1).toString() })

      mgrState.whitelist = await wallet.listWhitelistedAddresses()

      if (!useMock) {
        const web3 = new Web3(global.web3provider)
        mgrState.currentTime = new Date((await web3.eth.getBlock('latest')).timestamp * 1000).toString()
      }
    }

    return mgrState
  }

  eventSubscriber () {
    this.reloadState()
  }

  async initMgr () {
    if (mgr) {
      return // already initialized
    }
    if (useMock) {
      return this._initMockSdk()
    } else {
      return this._initRealSdk()
    }
  }

  async _initMockSdk () {
    // mock SDK...
    sdk = new SmartAccountSDK()
    // sdk.account = new AccountProxy()
    sdk.account = new AccountMock()

    mgr = new SimpleManagerMock({ accountApi: sdk.account })
    sms = mgr.smsApi
    sms.on('mocksms', (data) => {
      setTimeout(() => {
        alert('Received SMS to ' + data.phone + ':\n' + data.message)
      }, 1000)
    })
    if (getParam('auto')) {
      setTimeout(() => this.debugActiveWallet(), 300)
    }
  }

  async _initRealSdk () {
    const backendURL = window.location.protocol + '//' + window.location.host.replace(/(:\d+)?$/, ':8888')

    // debug node runs on server's host. real node might use infura.
    const ethNodeUrl = window.location.protocol + '//' + window.location.host.replace(/(:\d+)?$/, ':8545')

    console.log('connecting to:', { backendURL, ethNodeUrl })
    const web3provider = new Web3.providers.HttpProvider(ethNodeUrl)
    global.web3provider = web3provider

    const backend = new ClientBackend({ backendURL })
    const { sponsor, factory, whitelistFactory } = (await backend.getAddresses())

    const relayOptions = {
      verbose,
      sponsor
    }
    sdk = await SmartAccountSDK.init({
      network: web3provider,
      relayOptions
    })

    const factoryConfig = {
      provider: sdk.provider,
      factoryAddress: factory,
      whitelistFactoryAddress: whitelistFactory
    }

    mgr = new SimpleManager({
      accountApi: sdk.account,
      backend,
      factoryConfig
    })

    async function asyncDump (title, promise) {
      try {
        const res = await promise
        console.log(title, res)
        return res
      } catch (e) {
        console.log(title, e)
      }
    }

    if (await asyncDump('sdk.isEnabled', sdk.isEnabled({ appUrl: window.location.href }))) {
      const info = await sdk.account.googleAuthenticate()
      if (info) {
        this.state.email = info.email
        this.state.ownerAddress = info.address
        this.state.jwt = info.jwt
      }
    }
  }

  async doRecoverWalletOnNewDevice () {
    if (window.confirm('Attempt to recover your wallet?\nIt takes few days..?\n' + getDeviceName())) {
      await mgr.recoverWallet({ jwt: this.state.jwt, title: getDeviceName() })
      window.alert('sms sent. use it in "Step 2"')
    }
  }

  async doValidateRecoverWallet (smsCode) {
    if (!smsCode) {
      smsCode = window.prompt('Enter recover SMS code')
      if (!smsCode) return
    }
    await mgr.validateRecoverWallet({ jwt: this.state.jwt, smsCode })
  }

  async doNewDeviceAddOperator () {
    if (window.confirm('Request to add this device as new operator?\n' + getDeviceName())) {
      await mgr.signInAsNewOperator({ jwt: this.state.jwt, title: getDeviceName() })
      // TODO: do we want to re-read "pendingAddOperatorNow" from server?
      // (can't from blockchain, since its not there..)
      this.reloadState({ pendingAddOperatorNow: true })
    }
  }

  async doOldDeviceApproveOperator () {
    const smsCode = prompt('Enter code received by SMS')
    if (!smsCode) {
      return
    }

    const { newOperatorAddress, title } = await wallet.validateAddOperatorNow({ jwt: this.state.jwt, smsCode })
    if (!window.confirm('Add as new operator:\nDevice:' + title + '\naddr:' + newOperatorAddress)) {
      return
    }
    await wallet.addOperatorNow(newOperatorAddress)
  }

  async doCancelPending (delayedOpId) {
    if (!delayedOpId) {
      const id = prompt('Enter pending index to cancel')
      if (!id) return
      const p = JSON.parse(JSON.stringify(this.state.walletPending))
      console.log('looking for id', id, 'in', p)
      const pending = p.find(x => x.index === id)
      if (!pending) {
        alert('No pending item with index=' + id)
        return
      }
      delayedOpId = pending.delayedOpId
    } else {
      if (!window.confirm('Are you sure you want to cancel this operation?')) { return }
    }

    this.asyncHandler(wallet.cancelPending(delayedOpId))
  }

  async doTransfer ({ symbol }) {
    try {
      const destination = prompt('Transfer ' + symbol + ' destination:')
      if (!destination) return
      const isWhitelisted = await wallet._isWhitelisted({ destination })
      const val = prompt((isWhitelisted ? 'DIERCT ' : 'Scheduled ') + 'Transfer ' + symbol + ' amount:')
      if (!(val > 0)) return
      const tokinfo = this.state.walletBalances.find(b => b.symbol === symbol)
      const factor = '1' + '0'.repeat(tokinfo.decimals || 0)
      const amount = toBN(val * factor)

      // if (amount > this.state.walletBalances) {
      //   alert('you don\'t have that much.')
      //   return
      // }

      await wallet.transfer({ destination, amount, token: symbol })
    } catch (e) {
      this.reloadState({ err: errorStr(e) })
    }
  }

  debugIncreaseTime () {
    const hours = 24
    if (!window.confirm('Perform increaseTime of ' + hours + ' hours')) { return }
    const web3 = new Web3(global.web3provider)
    console.log('increaseTime')
    increaseTime(3600 * hours, web3).then((ret) => {
      console.log('increaseTime ret=', ret)
      this.reloadState()
    })
  }

  debugReloadState () {
    console.log('DEBUG: reload state')
    this.reloadState()
  }

  reloadState (extra = {}) {
    const self = this
    this.readMgrState().then(mgrState => {
      const newState = { ...mgrState, ...extra, debug }
      console.log('newState', newState)
      self.setState(newState)
    })
  }

  async signout () {
    if (!window.confirm('Signing out and requesting to self as operator\n' +
      'has wallet=' + !!wallet)) {
      return
    }
    // TODO: currently, we initmgr means its online, though not strictly required for singout..
    await this.initMgr()

    if (wallet) {
      const address = await mgr.getOwner()
      await wallet.removeParticipantByAddress({ address })
    }
    await mgr.signOut()

    // clear entire react state:
    const keys = Object.keys(this.state)
    const obj = this.state
    for (const k in keys) {
      obj[keys[k]] = undefined
    }
    window.location.reload()
  }

  async debugActiveWallet () {
    await this.initMgr()
    this.enableApp()
    const { jwt } = await mgr.googleLogin()
    // await mgr.validatePhone({jwt, phone:123})
    if (!await mgr.hasWallet()) {
      await mgr.createWallet({ jwt, phoneNumber: '123', smsVerificationCode: 'v123' })
    } else {
      await mgr.loadWallet()
    }
    this.reloadState()
  }

  toggleDebug () {
    // TODO: update #debug in URL - without reload page..
    debug = !debug
    this.reloadState()
  }

  async enableApp () {
    try {
      await this.initMgr()
      await sdk.enableApp({ appTitle: 'SampleWallet', appUrl: window.location.href })
      this.reloadState()
    } catch (e) {
      this.reloadState({ err: errorStr(e) })
    }
  }

  async debugFundWallet () {
    const val = prompt('DEBUG: fund wallet with ETH')
    if (!val) return
    const walletAddr = this.state.walletInfo.address
    const web3 = new Web3(global.web3provider)
    const accounts = await web3.eth.getAccounts()
    await web3.eth.sendTransaction({ from: accounts[0], to: walletAddr, value: web3.utils.toBN(val * 1e18) })
    // this.reloadState() // to see if wallet reads balance..
  }

  async doAddToWhiteList () {
    const addr = window.prompt('Add to whitelist')
    if (!addr) return
    await wallet.setWhitelistedDestination(addr, true)
  }

  async doRemoveFromWhitelist (addr) {
    if (!window.confirm('Remove from whitelist: ' + addr)) { return }
    await wallet.setWhitelistedDestination(addr, false)
  }

  render () {
    return (
      <div style={{ margin: '10px' }}>
        <h1>SampleWallet app</h1>
        <div style={{ fontSize: '10px' }}>
          <input type="checkbox" checked={this.state.debug} onChange={() => this.toggleDebug()}/>
          Debug state = {debug}
          {
            this.state.debug &&
            <xmp>{JSON.stringify(this.state, null, 4)}</xmp>
          }
        </div>
        <div>
          {
            !!(useMock && !(mgr && mgr.wallet)) &&
            <Button title="DEBUG: activate wallet" action={this.debugActiveWallet.bind(this)}/>
          }
          <Button title="DEBUG: fund wallet with ETH" action={() => this.debugFundWallet()}/>
          <Button title="DEBUG: reloadState" action={() => this.debugReloadState()}/>
          <Button title="DEBUG: increaseTime" action={() => this.debugIncreaseTime()}/>
        </div>
        <Button title="signout" action={this.signout.bind(this)}/><p/>
        {
          this.state.needApprove &&
          <div><Button title="Must first connect app to iframe wallet" action={() => this.enableApp()}/></div>
        }
        {
          this.state.err &&
          <div style={{ color: 'red' }} onClick={() => this.setState({ err: undefined })}> <pre>
            <h2>Error: {this.state.err} </h2></pre>
          </div>
        }
        <WalletComponent
          initMgr={() => this.initMgr()}
          doTransfer={params => this.doTransfer(params)}
          doCancelPending={params => this.doCancelPending(params)}
          doNewDeviceAddOperator={() => this.doNewDeviceAddOperator()}
          doOldDeviceApproveOperator={() => this.asyncHandler(this.doOldDeviceApproveOperator())}
          doRecoverWalletOnNewDevice={() => this.doRecoverWalletOnNewDevice()}
          doValidateRecoverWallet={() => this.doValidateRecoverWallet()}
          doAddToWhiteList={() => this.doAddToWhiteList()}
          doRemoveFromWhitelist={(addr) => this.doRemoveFromWhitelist(addr)}
          setUserConfig={config => this.setState({ userConfig: config })}
          refresh={(extra) => this.reloadState(extra)} {...this.state} />

      </div>
    )
  }
}

export default App
