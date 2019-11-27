/* npm modules */
const Chai = require('chai');
const Web3 = require('web3');

/* truffle artifacts */
const WhitelistBypassPolicy = artifacts.require("WhitelistBypassPolicy");
const AllowAllPolicy = artifacts.require("AllowAllPolicy");
const TestContract = artifacts.require("TestContract");
const TestPolicy = artifacts.require("TestPolicy");
const Gatekeeper = artifacts.require("Gatekeeper");
const Utilities = artifacts.require("Utilities");
const DAI = artifacts.require("DAI");

const testUtils = require('./utils');
const ChangeType = require('./etc/ChangeType');

const Permissions = require('../src/js/Permissions');
const utils = require('../src/js/SafeChannelUtils');
const Participant = require('../src/js/Participant');

const expect = Chai.expect;

Chai.use(require('ethereum-waffle').solidity);
Chai.use(require('bn-chai')(web3.utils.toBN));

const minuteInSec = 60;
const hourInSec = 60 * minuteInSec;
const dayInSec = 24 * hourInSec;
const yearInSec = 365 * dayInSec;

async function getDelayedOpHashFromEvent(log, utilities) {
    let actions = log.args.actions;
    let args1 = log.args.actionsArguments1;
    let args2 = log.args.actionsArguments2;
    let stateId = log.args.stateId;
    let schedulerAddress = log.args.sender;
    let schedulerPermsLevel = log.args.senderPermsLevel;
    let boosterAddress = log.args.booster;
    let boosterPermsLevel = log.args.boosterPermsLevel;
    return (await utilities.transactionHashPublic(actions, args1, args2, stateId, schedulerAddress, schedulerPermsLevel, boosterAddress, boosterPermsLevel));
}

async function cancelDelayed({res, log}, fromParticipant, gatekeeper) {
    let {actions, args1, args2, schedulerAddress, schedulerPermsLevel, boosterAddress, boosterPermsLevel, scheduledStateId} = extractLog(log, res);
    return gatekeeper.cancelOperation(
        actions,
        args1,
        args2,
        scheduledStateId,
        schedulerAddress,
        schedulerPermsLevel,
        boosterAddress,
        boosterPermsLevel,
        fromParticipant.permLevel,
        {from: fromParticipant.address});
}

function extractLog(log, res) {
    if (log === undefined) {
        log = res.logs[0];
    }
    let actions = log.args.actions;
    let args1 = log.args.actionsArguments1;
    let args2 = log.args.actionsArguments2;
    let schedulerAddress = log.args.sender;
    let schedulerPermsLevel = log.args.senderPermsLevel;
    let boosterAddress = log.args.booster;
    let boosterPermsLevel = log.args.boosterPermsLevel;

    let scheduledStateId = log.args.stateId;

    let bypassHash = log.args.bypassHash;
    let target = log.args.target;
    let value = log.args.value;
    let msgdata = log.args.msgdata;

    return {
        actions,
        args1,
        args2,
        schedulerAddress,
        schedulerPermsLevel,
        boosterAddress,
        boosterPermsLevel,
        bypassHash,
        target,
        value,
        msgdata,
        scheduledStateId
    };
}

async function applyBypass({res, log}, fromParticipant, gatekeeper) {
    let {msgdata, value, target, schedulerAddress, schedulerPermsLevel, boosterAddress, boosterPermsLevel, scheduledStateId} = extractLog(log, res);

    return gatekeeper.applyBypassCall(
        fromParticipant.permLevel,
        schedulerAddress,
        schedulerPermsLevel,
        scheduledStateId,
        target,
        value,
        msgdata,
        {from: fromParticipant.address});
}

async function applyDelayed({res, log}, fromParticipant, gatekeeper) {
    let {actions, args1, args2, schedulerAddress, schedulerPermsLevel, boosterAddress, boosterPermsLevel, scheduledStateId} = extractLog(log, res);

    return gatekeeper.applyConfig(
        fromParticipant.permLevel,
        actions,
        args1,
        args2,
        scheduledStateId,
        schedulerAddress,
        schedulerPermsLevel,
        boosterAddress,
        boosterPermsLevel,
        {from: fromParticipant.address});
}

contract('Gatekeeper', async function (accounts) {
    let gatekeeper;
    let utilities;
    let erc20;
    let fundedAmount = 300;
    let from = accounts[0];
    let level = 1;
    let freezerLevel = 2;
    let highLevel = 3;
    let zeroAddress = "0x0000000000000000000000000000000000000000";
    let trustedForwarder = zeroAddress;
    let relayHub = zeroAddress;
    let destinationAddress = accounts[2];
    let timeGap = 60 * 60 * 24 * 2 + 10;
    let initialDelays;
    let initialParticipants;
    let requiredApprovalsPerLevel;
    let operatorA;
    let operatorB;
    let operatorZ;
    let wrongaddr;
    let adminA;
    let adminB;
    let adminB1;
    let adminB2;
    let adminC;
    let adminZ;
    let watchdogA;
    let watchdogB;
    let watchdogB1;
    let watchdogC;
    let watchdogZ;
    let amount = 100;
    let startBlock;
    let web3;
    let expectedDelayedEventsCount = 0;
    let ownerPermissions;
    let adminPermissions;
    let watchdogPermissions;

    before(async function () {
        // Merge events so Gatekeeper knows about ERC20’s events
        Object.keys(DAI.events).forEach(function (topic) {
            Gatekeeper.network.events[topic] = DAI.events[topic];
        });
        Object.keys(TestContract.events).forEach(function (topic) {
            Gatekeeper.network.events[topic] = TestContract.events[topic];
        });

        gatekeeper = await Gatekeeper.new(zeroAddress, accounts[0], {gas: 8e6});
        utilities = await Utilities.deployed();
        erc20 = await DAI.new();
        web3 = new Web3(gatekeeper.contract.currentProvider);
        ownerPermissions = utils.bufferToHex(await gatekeeper.ownerPermissions());
        adminPermissions = utils.bufferToHex(await gatekeeper.adminPermissions());
        watchdogPermissions = utils.bufferToHex(await gatekeeper.watchdogPermissions());
        console.log(`ownerPermissions: ${ownerPermissions}`);
        console.log(`adminPermissions: ${adminPermissions}`);
        console.log(`watchdogPermissions: ${watchdogPermissions}}`);
        startBlock = await web3.eth.getBlockNumber();
        initParticipants();
    });

    function initParticipants() {
        operatorA = new Participant(accounts[0], ownerPermissions, level, "operatorA");
        operatorB = new Participant(accounts[11], ownerPermissions, level, "operatorB");
        operatorZ = new Participant(accounts[14], ownerPermissions, 5, "operatorZ");
        wrongaddr = new Participant(accounts[1], ownerPermissions, level, "wrongAddress");
        adminA = new Participant(accounts[3], adminPermissions, level, "adminA");
        adminB = new Participant(accounts[4], adminPermissions, level, "adminB");
        adminB1 = new Participant(accounts[5], adminPermissions, highLevel, "adminB1");
        adminB2 = new Participant(accounts[13], adminPermissions, freezerLevel, "adminB2");
        adminC = new Participant(accounts[6], adminPermissions, level, "adminC");
        adminZ = new Participant(accounts[13], adminPermissions, 5, "adminZ");
        watchdogA = new Participant(accounts[7], watchdogPermissions, level, "watchdogA");
        watchdogB = new Participant(accounts[8], watchdogPermissions, freezerLevel, "watchdogB");
        watchdogB1 = new Participant(accounts[9], watchdogPermissions, level, "watchdogB1");
        watchdogC = new Participant(accounts[10], watchdogPermissions, level, "watchdogC");
        watchdogZ = new Participant(accounts[12], watchdogPermissions, 5, "watchdogZ");
    }

    async function getLastEvent(contract, event, expectedCount) {
        let delayedEvents = await contract.getPastEvents(event, {
            fromBlock: startBlock,
            toBlock: 'latest'
        });
        // If 'contract' changes, just make sure to take the right one
        assert.equal(delayedEvents.length, expectedCount);
        return delayedEvents[delayedEvents.length - 1].returnValues;
    }

    it("should not receive the initial configuration with too many participants", async function () {
        let wrongInitialDelays = [];
        let initialParticipants = Array(21).fill("0x1123123");
        await expect(
            gatekeeper.initialConfig(initialParticipants, wrongInitialDelays, true, true, [0, 0, 0], [], [], [])
        ).to.be.revertedWith("too many participants");
    });

    it("should not receive the initial configuration with too many levels", async function () {
        let wrongInitialDelays = Array(11).fill(10);
        let initialParticipants = [];
        await expect(
            gatekeeper.initialConfig(initialParticipants, wrongInitialDelays, true, true, [0, 0, 0], [], [], [])
        ).to.be.revertedWith("too many levels");
        await expect(
            gatekeeper.initialConfig(initialParticipants, [], true, true, Array(11).fill(0), [], [], [])
        ).to.be.revertedWith("too many levels again");

    });

    it("should not receive the initial configuration with delay too long", async function () {
        let wrongInitialDelays = Array.from({length: 10}, (x, i) => (i + 1) * yearInSec);
        let initialParticipants = [];
        await expect(
            gatekeeper.initialConfig(initialParticipants, wrongInitialDelays, true, true, [0, 0, 0], [], [], [])
        ).to.be.revertedWith("Delay too long");
    });

    /* Initial configuration */
    it("should receive the initial vault configuration", async function () {
        initialDelays = Array.from({length: 10}, (x, i) => (i + 1) * dayInSec);
        requiredApprovalsPerLevel = [0, 0, 1, 2, 3, 4, 5, 6, 7, 8];
        initialParticipants = [
            utils.bufferToHex(utils.participantHash(operatorA.address, operatorA.permLevel)),
            utils.bufferToHex(utils.participantHash(adminA.address, adminA.permLevel)),
            utils.bufferToHex(utils.participantHash(adminB.address, adminB.permLevel)),
            utils.bufferToHex(utils.participantHash(watchdogA.address, watchdogA.permLevel)),
            utils.bufferToHex(utils.participantHash(watchdogZ.address, watchdogZ.permLevel)),
            utils.bufferToHex(utils.participantHash(adminZ.address, adminZ.permLevel)),
            utils.bufferToHex(utils.participantHash(adminB2.address, adminB2.permLevel)),
        ];

        let res = await gatekeeper.initialConfig(initialParticipants, initialDelays, true, true, requiredApprovalsPerLevel, [], [], [], {from: operatorA.address});
        let log = res.logs[0];
        assert.equal(log.event, "GatekeeperInitialized");

        // let participants = [operatorA, adminA, adminB, watchdogA, watchdogB, operatorB, adminC, wrongaddr];
        let participants = [
            operatorA.expect(),
            adminA.expect(),
            adminB.expect(),
            watchdogA.expect(),
            adminB2.expect(),
            watchdogB,
            operatorB,
            adminC,
            wrongaddr];
        await utils.validateConfigParticipants(participants, gatekeeper);
        await utils.validateConfigDelays(initialDelays, gatekeeper);
        await utils.validateConfigApprovalsPerLevel(requiredApprovalsPerLevel, gatekeeper);
    });

    it("should not receive the initial configuration after configured once", async function () {
        let initialDelays = [];
        let initialParticipants = [];
        await expect(
            gatekeeper.initialConfig(initialParticipants, initialDelays, true, true, requiredApprovalsPerLevel, [], [], [], {from: operatorA.address})
        ).to.be.revertedWith("already initialized");
    });
    /* Positive flows */

    describe("testing accelerated calls flag", function () {
        // it("should revert when trying to cancel a transfer transaction that does not exist", async function () {
        //     await expect(
        //         gatekeeper.cancelBypassCall(watchdogA.permLevel, operatorA.address, operatorA.permLevel, 0, zeroAddress, 0, [], {from: watchdogA.address})
        //     ).to.be.revertedWith("cancel called for non existent pending bypass call");
        // });
        //
        // it("should allow the owner to create a delayed ether transfer transaction", async function () {
        //     let stateId = await gatekeeper.stateNonce();
        //     let res = await gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, []);
        //     expectedDelayedEventsCount++;
        //     let log = res.logs[0];
        //     assert.equal(log.event, "BypassCallPending");
        //     assert.equal(log.address, gatekeeper.address);
        //     assert.equal(log.args.target, destinationAddress);
        //     assert.equal(log.args.value, amount);
        //     let hash = "0x" + utils.bypassCallHash(stateId, operatorA.address, operatorA.permLevel, destinationAddress, amount, "").toString("hex");
        //     let pendingCall = await gatekeeper.pendingBypassCalls(hash);
        //     assert.isAbove(pendingCall.toNumber(), 0)
        // });
        //
        // it("just funding the vault", async function () {
        //     await web3.eth.sendTransaction({from: operatorA.address, to: gatekeeper.address, value: amount * 10});
        // });
        //
        // it("should allow the owner to execute a delayed transfer transaction after delay", async function () {
        //
        //     let addedLog = await getLastEvent(gatekeeper.contract, "BypassCallPending", expectedDelayedEventsCount);
        //     let balanceSenderBefore = parseInt(await web3.eth.getBalance(gatekeeper.address));
        //     let balanceReceiverBefore = parseInt(await web3.eth.getBalance(destinationAddress));
        //     assert.isAbove(balanceSenderBefore, amount);
        //     await utils.increaseTime(timeGap, web3);
        //     let res = await gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, addedLog.stateNonce, addedLog.target, addedLog.value, [], {from: operatorA.address});
        //     let log = res.logs[0];
        //
        //     assert.equal(log.event, "BypassCallApplied");
        //     let hash = "0x" + utils.bypassCallHash(addedLog.stateNonce, operatorA.address, operatorA.permLevel, addedLog.target, addedLog.value, "").toString("hex");
        //     assert.equal(log.args.bypassHash, hash);
        //     assert.equal(log.args.status, true);
        //
        //     let balanceSenderAfter = parseInt(await web3.eth.getBalance(gatekeeper.address));
        //     let balanceReceiverAfter = parseInt(await web3.eth.getBalance(destinationAddress));
        //     assert.equal(balanceSenderAfter, balanceSenderBefore - amount);
        //     assert.equal(balanceReceiverAfter, balanceReceiverBefore + amount);
        // });
        //
        // it(`should allow the cancellers to cancel a delayed transfer transaction`, async function () {
        //     await utils.asyncForEach(
        //         [operatorA, watchdogA],
        //         async (participant) => {
        //             let res1 = await gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, []);
        //             expectedDelayedEventsCount++;
        //             let log1 = res1.logs[0];
        //
        //             let res2 = await gatekeeper.cancelBypassCall(
        //                 participant.permLevel,
        //                 log1.args.sender,
        //                 log1.args.senderPermsLevel,
        //                 log1.args.stateNonce,
        //                 log1.args.target,
        //                 log1.args.value,
        //                 [],
        //                 {from: participant.address});
        //             let log2 = res2.logs[0];
        //             assert.equal(log2.event, "BypassCallCancelled");
        //             assert.equal(log2.address, log1.address);
        //         });
        // });

        it("should disable accelerated calls", async function () {
            await expect(
                gatekeeper.executeBypassCall(operatorA.permLevel, destinationAddress, amount, [])
            ).to.be.revertedWith("Call cannot be executed immediately")
            assert.equal(true, await gatekeeper.allowAcceleratedCalls());
            let stateId = await gatekeeper.stateNonce();
            let actions = [ChangeType.SET_ACCELERATED_CALLS];
            // bool to bytes32 basically...
            let args = [Buffer.from("0".repeat(64), "hex")];
            let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            applyDelayed({res}, operatorA, gatekeeper);
            assert.equal(false, await gatekeeper.allowAcceleratedCalls());
        });

        it("should revert accelerated calls when disabled", async function () {
            await expect(
                gatekeeper.executeBypassCall(operatorA.permLevel, destinationAddress, amount, [])
            ).to.be.revertedWith("Accelerated calls blocked")
        });


        it("should re-enable accelerated calls", async function () {
            assert.equal(false, await gatekeeper.allowAcceleratedCalls());
            let stateId = await gatekeeper.stateNonce();
            let actions = [ChangeType.SET_ACCELERATED_CALLS];
            // bool to bytes32 basically...
            let args = [Buffer.from("1".repeat(64), "hex")];
            let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            applyDelayed({res}, operatorA, gatekeeper);
            assert.equal(true, await gatekeeper.allowAcceleratedCalls());
            await expect(
                gatekeeper.executeBypassCall(operatorA.permLevel, destinationAddress, amount, [])
            ).to.be.revertedWith("Call cannot be executed immediately")

        });

    });

    /* Plain send */
    it("should allow the owner to create a delayed ether transfer transaction", async function () {
        let stateId = await gatekeeper.stateNonce();
        let res = await gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, [], stateId);
        expectedDelayedEventsCount++;
        let log = res.logs[0];
        assert.equal(log.event, "BypassCallPending");
        assert.equal(log.address, gatekeeper.address);
        assert.equal(log.args.target, destinationAddress);
        assert.equal(log.args.value, amount);
        let hash = "0x" + utils.bypassCallHash(stateId, operatorA.address, operatorA.permLevel, destinationAddress, amount, "").toString("hex");
        let pendingCall = await gatekeeper.pendingBypassCalls(hash);
        assert.isAbove(pendingCall.toNumber(), 0)
    });

    it("just funding the vault", async function () {
        await web3.eth.sendTransaction({from: operatorA.address, to: gatekeeper.address, value: amount * 10});
    });

    it("should allow the owner to execute a delayed transfer transaction after delay", async function () {

        let addedLog = await getLastEvent(gatekeeper.contract, "BypassCallPending", expectedDelayedEventsCount);
        let balanceSenderBefore = parseInt(await web3.eth.getBalance(gatekeeper.address));
        let balanceReceiverBefore = parseInt(await web3.eth.getBalance(destinationAddress));
        assert.isAbove(balanceSenderBefore, amount);
        await utils.increaseTime(timeGap, web3);
        let res = await gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, addedLog.stateId, addedLog.target, addedLog.value, [], {from: operatorA.address});
        let log = res.logs[0];

        assert.equal(log.event, "BypassCallApplied");
        let hash = "0x" + utils.bypassCallHash(addedLog.stateId, operatorA.address, operatorA.permLevel, addedLog.target, addedLog.value, "").toString("hex");
        assert.equal(log.args.bypassHash, hash);
        assert.equal(log.args.status, true);

        let balanceSenderAfter = parseInt(await web3.eth.getBalance(gatekeeper.address));
        let balanceReceiverAfter = parseInt(await web3.eth.getBalance(destinationAddress));
        assert.equal(balanceSenderAfter, balanceSenderBefore - amount);
        assert.equal(balanceReceiverAfter, balanceReceiverBefore + amount);
    });

    it("funding the vault with ERC20 tokens", async function () {
        await testUtils.fundVaultWithERC20(gatekeeper.address, erc20, fundedAmount, from);
    });

    it("should allow the owner to create a delayed erc20 transfer transaction", async function () {
        let calldata = erc20.contract.methods.transfer(destinationAddress, amount).encodeABI();
        let stateId = await gatekeeper.stateNonce()
        let res = await gatekeeper.scheduleBypassCall(operatorA.permLevel, erc20.address, 0, calldata, stateId);
        expectedDelayedEventsCount++;
        let log = res.logs[0];
        assert.equal(log.event, "BypassCallPending");
        assert.equal(log.address, gatekeeper.address);
        assert.equal(log.args.value, 0);
        assert.equal(log.args.target, erc20.address);

        let hash = "0x" + utils.bypassCallHash(log.args.stateId, log.args.sender, log.args.senderPermsLevel, log.args.target, log.args.value, log.args.msgdata).toString("hex");
        let pendingCall = await gatekeeper.pendingBypassCalls(hash);
        assert.isAbove(pendingCall.toNumber(), 0)
    });

    it("should allow the owner to execute a delayed erc20 transfer transaction after delay", async function () {

        let addedLog = await getLastEvent(gatekeeper.contract, "BypassCallPending", expectedDelayedEventsCount);
        let balanceSenderBefore = (await erc20.balanceOf(gatekeeper.address)).toNumber();
        let balanceReceiverBefore = (await erc20.balanceOf(destinationAddress)).toNumber();
        assert.isAbove(balanceSenderBefore, amount);
        await utils.increaseTime(timeGap, web3);

        let res = await gatekeeper.applyBypassCall(operatorA.permLevel, addedLog.sender, addedLog.senderPermsLevel, addedLog.stateId, addedLog.target, addedLog.value, addedLog.msgdata, {from: operatorA.address});

        let log = res.logs[0];
        assert.equal(log.event, "Transfer");
        assert.equal(log.args.value, amount);
        assert.equal(log.args.from, gatekeeper.address);
        assert.equal(log.args.to, destinationAddress);

        log = res.logs[1];
        // TODO: TBD: should this event have other fields, or is it more reliable to lookup the 'scheduled' event?
        assert.equal(log.event, "BypassCallApplied");
        assert.equal(log.args.status, true);

        let balanceSenderAfter = (await erc20.balanceOf(gatekeeper.address)).toNumber();
        let balanceReceiverAfter = (await erc20.balanceOf(destinationAddress)).toNumber();
        assert.equal(balanceSenderAfter, balanceSenderBefore - amount);
        assert.equal(balanceReceiverAfter, balanceReceiverBefore + amount);
    });

    it("should revert an attempt to re-apply a bypass call ", async function () {

        let addedLog = await getLastEvent(gatekeeper.contract, "BypassCallPending", expectedDelayedEventsCount);
        let balanceSenderBefore = (await erc20.balanceOf(gatekeeper.address)).toNumber();
        let balanceReceiverBefore = (await erc20.balanceOf(destinationAddress)).toNumber();
        assert.isAbove(balanceSenderBefore, amount);
        await utils.increaseTime(timeGap, web3);

        await expect(
            gatekeeper.applyBypassCall(operatorA.permLevel, addedLog.sender, addedLog.senderPermsLevel, addedLog.stateId, addedLog.target, addedLog.value, addedLog.msgdata, {from: operatorA.address})
        ).to.be.revertedWith("apply called for non existent pending bypass call");
    });

    describe("custom delay tests", async function () {
        let maxDelay = 365 * yearInSec;
        // TODO: new negative flow tests for 'schedule' flow
        it.skip("should revert delayed ETH transfer due to invalid delay", async function () {
            let stateId = await gatekeeper.stateNonce();
            await expect(
                gatekeeper.sendEther(operatorA.permLevel, destinationAddress, amount, initialDelays[0], stateId)
            ).to.be.revertedWith("Invalid delay given");
            await expect(
                gatekeeper.sendEther(operatorA.permLevel, destinationAddress, amount, maxDelay + 1, stateId)
            ).to.be.revertedWith("Invalid delay given");

        });
    });

    /**
     * If running this 'describe' only, do not forget to initialize and fund the gatekeeper
     */
    describe("Bypass Modules", async function () {

        let module;
        let allowAll;
        let testPolicy;
        let testContract;
        let differentErc20;
        let targetThatCanDoAll;
        let whitelistedDestination;

        before(async function () {
            whitelistedDestination = adminB2.address;
            module = await WhitelistBypassPolicy.new(gatekeeper.address, [whitelistedDestination]);
            allowAll = await AllowAllPolicy.new();
            testPolicy = await TestPolicy.new();
            testContract = await TestContract.new();
            differentErc20 = await DAI.new();
            targetThatCanDoAll = erc20.address;
            await differentErc20.transfer(gatekeeper.address, 1000000);
        });

        it("should add a bypass module by target after delay", async function () {
            let actions = [ChangeType.ADD_BYPASS_BY_TARGET, ChangeType.ADD_BYPASS_BY_TARGET];
            let stateId = await gatekeeper.stateNonce();
            let res = await gatekeeper.changeConfiguration(
                operatorA.permLevel, actions, [targetThatCanDoAll, testContract.address], [allowAll.address, testPolicy.address], stateId);
            await utils.increaseTime(timeGap, web3);
            let res2 = await applyDelayed({res}, operatorA, gatekeeper);
            let bypassForTarget = await gatekeeper.bypassPoliciesByTarget(erc20.address);
            assert.equal(res2.logs[0].event, "BypassByTargetAdded");
            assert.equal(res2.logs[0].args.target, erc20.address);
            assert.equal(res2.logs[0].args.bypass, allowAll.address);
            assert.equal(bypassForTarget, allowAll.address);
        });

        it("should add a bypass module by method after delay", async function () {
            let actions = [ChangeType.ADD_BYPASS_BY_METHOD];
            let stateId = await gatekeeper.stateNonce();
            let method = erc20.contract.methods.approve(operatorA.address, 0).encodeABI().substr(0, 10);
            let methods = [method];
            let res = await gatekeeper.changeConfiguration(
                operatorA.permLevel, actions, methods, [module.address], stateId);
            await utils.increaseTime(timeGap, web3);
            let res2 = await applyDelayed({res}, operatorA, gatekeeper);
            let bypassForMethod = await gatekeeper.bypassPoliciesByMethod(method);
            assert.equal(res2.logs[0].event, "BypassByMethodAdded");
            assert.equal(res2.logs[0].args.method, method);
            assert.equal(res2.logs[0].args.bypass, module.address);
            assert.equal(bypassForMethod, module.address);
        });

        it("should use default level settings if no module configured", async function () {
            let calldata = erc20.contract.methods.transfer(whitelistedDestination, 1000000).encodeABI();
            await expect(
                gatekeeper.executeBypassCall(operatorA.permLevel, differentErc20.address, 0, calldata)
            ).to.be.revertedWith("Call cannot be executed immediately");
            let stateId = await gatekeeper.stateNonce();
            let res = await gatekeeper.scheduleBypassCall(operatorA.permLevel, differentErc20.address, 0, calldata, stateId);
            await utils.increaseTime(timeGap, web3);
            let res2 = await applyBypass({res}, operatorA, gatekeeper);
            assert.equal(res2.logs[0].event, "Transfer");
            assert.equal(res2.logs[1].event, "BypassCallApplied");
        });

        it("should bypass a call by target first", async function () {
            let calldata = erc20.contract.methods.increaseAllowance(whitelistedDestination, 1000000).encodeABI();
            let res = await gatekeeper.executeBypassCall(operatorA.permLevel, targetThatCanDoAll, 0, calldata);
            assert.equal(res.logs[0].event, "Approval");
        });

        it("should bypass a call by method if no module-by-target is set", async function () {
            let calldata = erc20.contract.methods.approve(whitelistedDestination, 1000000).encodeABI();
            let res = await gatekeeper.executeBypassCall(operatorA.permLevel, differentErc20.address, 0, calldata);
            assert.equal(res.logs[0].event, "Approval");
        });

        it("should apply call once approval is given if the policy allows this", async function () {
            let stateId = await gatekeeper.stateNonce();
            await gatekeeper.scheduleBypassCall(operatorA.permLevel, testContract.address, 7, [], stateId);
            await expect(
                gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 7, [])
            ).to.be.revertedWith("Pending approvals");

            await expect(
                gatekeeper.approveBypassCall(
                    adminA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 7, [],
                    {
                        from: adminA.address
                    }
                )
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanApprove}`);
            await gatekeeper.approveBypassCall(
                watchdogA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 7, [],
                {
                    from: watchdogA.address
                }
            );
            let res = await gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 7, []);
            assert.equal(res.logs[0].event, "DoNotWaitForDelay");
        });

        it("should apply call only after delay even if approval is given", async function () {
            let stateId = await gatekeeper.stateNonce();
            await gatekeeper.scheduleBypassCall(operatorA.permLevel, testContract.address, 6, [], stateId);
            await expect(
                gatekeeper.approveBypassCall(
                    adminA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 6, [],
                    {
                        from: adminA.address
                    }
                )
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanApprove}`);
            await gatekeeper.approveBypassCall(
                watchdogA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 6, [],
                {
                    from: watchdogA.address
                }
            );
            await expect(
                gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 6, [])
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            let res = await gatekeeper.applyBypassCall(operatorA.permLevel, operatorA.address, operatorA.permLevel, stateId, testContract.address, 6, []);
            assert.equal(res.logs[0].event, "WaitForDelay");
        });
    });

    /* Canceled send, rejected send */

    it("should revert when trying to cancel a transfer transaction that does not exist", async function () {
        await expect(
            gatekeeper.cancelBypassCall(watchdogA.permLevel, operatorA.address, operatorA.permLevel, 0, zeroAddress, 0, [], {from: watchdogA.address})
        ).to.be.revertedWith("cancel called for non existent pending bypass call");
    });

    it("should allow the owner to create a delayed config transaction", async function () {

        let actions = [ChangeType.ADD_PARTICIPANT];
        let args = [utils.participantHash(adminB1.address, adminB1.permLevel)];
        let stateId = await gatekeeper.stateNonce();
        let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);
        let log = res.logs[0];
        assert.equal(log.event, "ConfigPending");
        assert.equal(log.args.sender, operatorA.address);
        assert.equal("0x" + log.args.senderPermsLevel.toString("hex"), operatorA.permLevel);
        assert.deepEqual(log.args.actions.map(it => {
            return it.toNumber()
        }), actions);
        assert.deepEqual(log.args.actionsArguments1, args.map(it => {
            return utils.bufferToHex(it)
        }));
    });

    it("should store admins' credentials hashed", async function () {
        let hash = utils.bufferToHex(utils.participantHash(adminA.address, adminA.permLevel));
        let isAdmin = await gatekeeper.participants(hash);
        assert.equal(true, isAdmin);
    });

    /* Rejected config change */
    it("should allow the watchdog to cancel a delayed config transaction", async function () {
        let log = await testUtils.extractLastConfigPendingEvent(gatekeeper);
        let hash = await getDelayedOpHashFromEvent(log, utilities);
        let res2 = await cancelDelayed({log}, watchdogA, gatekeeper);
        let log2 = res2.logs[0];
        assert.equal(log2.event, "ConfigCancelled");
        assert.equal(log2.args.transactionHash, hash);
        assert.equal(log2.args.sender, watchdogA.address);

        await utils.validateConfigParticipants(
            [adminA.expect(), adminB.expect(), adminB1],
            gatekeeper);
    });

    it("should not allow the watchdog to cancel operations scheduled by a higher level participants");

    it("should revert an attempt to delete admin that is not a part of the config", async function () {
        let actions = [ChangeType.REMOVE_PARTICIPANT];
        let args = [utils.participantHash(adminC.address, adminC.permLevel)];
        let stateId = await gatekeeper.stateNonce();
        let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);
        let log = res.logs[0];
        assert.equal(log.event, "ConfigPending");
        await utils.increaseTime(timeGap, web3);
        await expect(
            applyDelayed({res}, operatorA, gatekeeper)
        ).to.be.revertedWith("there is no such participant");
    });

    it("should allow the owner to add an admin after a delay", async function () {
        let actions = [ChangeType.ADD_PARTICIPANT];
        let args = [utils.participantHash(adminC.address, adminC.permLevel)];
        let stateId = await gatekeeper.stateNonce();
        let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);

        await expect(
            applyDelayed({res}, operatorA, gatekeeper)
        ).to.be.revertedWith("called before due time");
        await utils.increaseTime(timeGap, web3);
        let res2 = await applyDelayed({res}, operatorA, gatekeeper);
        let log2 = res2.logs[0];
        let hash = utils.bufferToHex(utils.participantHash(adminC.address, adminC.permLevel));
        assert.equal(log2.event, "ParticipantAdded");
        assert.equal(log2.args.participant, hash);
        await utils.validateConfigParticipants(
            [adminA.expect(), adminB.expect(), adminB1, adminC.expect()],
            gatekeeper);
    });

    it("should allow the owner to delete an admin after a delay", async function () {
        let actions = [ChangeType.REMOVE_PARTICIPANT];
        let args = [utils.participantHash(adminC.address, adminC.permLevel)];
        let stateId = await gatekeeper.stateNonce();
        let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);
        let log = res.logs[0];
        assert.equal(log.event, "ConfigPending");
        await utils.increaseTime(timeGap, web3);
        let res2 = await applyDelayed({res}, operatorA, gatekeeper);
        assert.equal(res2.logs[0].event, "ParticipantRemoved");
        await utils.validateConfigParticipants(
            [adminA.expect(), adminB.expect(), adminB1, adminC],
            gatekeeper);

    });

    /* Admin replaced */
    it("should allow the owner to replace an admin after a delay", async function () {
        let stateId = await gatekeeper.stateNonce();
        let changeType1 = ChangeType.ADD_PARTICIPANT;
        let changeArg1 = utils.participantHash(adminB1.address, adminB1.permLevel);
        let changeType2 = ChangeType.REMOVE_PARTICIPANT;
        let changeArg2 = utils.participantHash(adminB.address, adminB.permLevel);
        await gatekeeper.changeConfiguration(operatorA.permLevel, [changeType1, changeType2], [changeArg1, changeArg2], [changeArg1, changeArg2], stateId);

        await expect(
            gatekeeper.applyConfig(operatorA.permLevel, [changeType1, changeType2], [changeArg1, changeArg2], [changeArg1, changeArg2], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
        ).to.be.revertedWith("called before due time");

        await utils.increaseTime(timeGap, web3);

        let res = await gatekeeper.applyConfig(operatorA.permLevel, [changeType1, changeType2], [changeArg1, changeArg2], [changeArg1, changeArg2], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0);

        assert.equal(res.logs[0].event, "ParticipantAdded");
        assert.equal(res.logs[1].event, "ParticipantRemoved");

        await utils.validateConfigParticipants(
            [adminA.expect(), adminB, adminB1.expect(), adminC],
            gatekeeper);
    });

    it("should revert an attempt to re-apply a config change", async function () {
        let stateId = await gatekeeper.stateNonce();
        let changeType1 = ChangeType.ADD_PARTICIPANT;
        let changeArg1 = utils.participantHash(adminB1.address, adminB1.permLevel);
        await gatekeeper.changeConfiguration(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId);

        await expect(
            gatekeeper.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
        ).to.be.revertedWith("called before due time");

        await utils.increaseTime(timeGap, web3);

        let res = await gatekeeper.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0);

        assert.equal(res.logs[0].event, "ParticipantAdded");

        await utils.validateConfigParticipants(
            [adminA.expect(), adminB1.expect(), adminC],
            gatekeeper);

        await expect(
            gatekeeper.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
        ).to.be.revertedWith("apply called for non existent pending change");
    });

    /* Owner loses phone */
    it("should allow an admin to add an operator after a delay", async function () {
        let participants = [operatorA.expect(), operatorB];
        await utils.validateConfigParticipants(participants, gatekeeper);
        let stateId = await gatekeeper.stateNonce();
        assert.equal(true, await gatekeeper.isParticipant(adminA.address, adminA.permLevel));
        assert.equal(false, await gatekeeper.isParticipant(operatorB.address, operatorB.permLevel));
        let res = await gatekeeper.scheduleAddOperator(adminA.permLevel, operatorB.address, stateId, {from: adminA.address});
        await expect(
            applyDelayed({res}, adminA, gatekeeper)
        ).to.be.revertedWith("apply called before due time")
        await utils.increaseTime(timeGap, web3);
        await applyDelayed({res}, adminA, gatekeeper);
        participants = [operatorA.expect(), operatorB.expect()];
        assert.equal(true, await gatekeeper.isParticipant(operatorB.address, operatorB.permLevel));
        await utils.validateConfigParticipants(participants, gatekeeper);
    });

    /* There is no scenario where this is described, but this is how it was implemented and now it is documented*/
    it("should allow an owner to remove an owner after a delay", async function () {
        let participants = [operatorA.expect(), operatorB.expect()];
        await utils.validateConfigParticipants(participants, gatekeeper);
        let stateId = await gatekeeper.stateNonce();
        let actions = [ChangeType.REMOVE_PARTICIPANT];
        let args = [utils.participantHash(operatorB.address, operatorB.permLevel)];
        let res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId, {from: operatorA.address});
        await utils.increaseTime(timeGap, web3);
        await applyDelayed({res}, operatorB, gatekeeper);
        participants = [operatorA.expect(), operatorB];
        await utils.validateConfigParticipants(participants, gatekeeper);
    });

    describe("testing immediate operator addition", function () {
        let res;

        it("should revert an attempt to add operator immediately by normal applyConfig()", async function () {
            let participants = [operatorA.expect(), operatorB];
            await utils.validateConfigParticipants(participants, gatekeeper);
            assert.equal(true, await gatekeeper.isParticipant(adminA.address, adminA.permLevel));
            assert.equal(false, await gatekeeper.isParticipant(operatorB.address, operatorB.permLevel));
            let stateId = await gatekeeper.stateNonce();
            res = await gatekeeper.addOperatorNow(operatorA.permLevel, operatorB.address, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("Use approveAddOperatorNow instead");
        });

        it("should cancel addOperatorNow operation", async function () {
            await expect(
                cancelDelayed({res}, adminA, gatekeeper)
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanCancel}`);
            res = await cancelDelayed({res}, watchdogA, gatekeeper);
            assert.equal(res.logs[0].event, "ConfigCancelled");
        });

        it("should add operator immediately with watchdog's approval", async function () {
            let participants = [operatorA.expect(), operatorB];
            await utils.validateConfigParticipants(participants, gatekeeper);
            assert.equal(true, await gatekeeper.isParticipant(adminA.address, adminA.permLevel));
            assert.equal(false, await gatekeeper.isParticipant(operatorB.address, operatorB.permLevel));
            let stateId = await gatekeeper.stateNonce();
            res = await gatekeeper.addOperatorNow(operatorA.permLevel, operatorB.address, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, adminA, gatekeeper)
            ).to.be.revertedWith("apply called before due time")
            stateId = res.logs[0].args.stateId;
            await expect(
                gatekeeper.approveAddOperatorNow(adminA.permLevel, operatorB.address, stateId, operatorA.address, operatorA.permLevel, {from: adminA.address})
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanApprove}`);
            await gatekeeper.approveAddOperatorNow(watchdogA.permLevel, operatorB.address, stateId, operatorA.address, operatorA.permLevel, {from: watchdogA.address});
            participants = [operatorA.expect(), operatorB.expect()];
            assert.equal(true, await gatekeeper.isParticipant(operatorB.address, operatorB.permLevel));
            await utils.validateConfigParticipants(participants, gatekeeper);
        });

        it("should disable adding operator immediately", async function () {
            assert.equal(true, await gatekeeper.allowAddOperatorNow());
            let stateId = await gatekeeper.stateNonce();
            let actions = [ChangeType.SET_ADD_OPERATOR_NOW];
            // bool to bytes32 basically...
            let args = [Buffer.from("0".repeat(64), "hex")];
            res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            applyDelayed({res}, operatorA, gatekeeper);
            assert.equal(false, await gatekeeper.allowAddOperatorNow());
            stateId = await gatekeeper.stateNonce();
            await expect(
                gatekeeper.addOperatorNow(operatorA.permLevel, operatorB.address, stateId, {from: operatorA.address})
            ).to.be.revertedWith("Call blocked")
        });

        it("should re-enable adding operator immediately", async function () {
            assert.equal(false, await gatekeeper.allowAddOperatorNow());
            let stateId = await gatekeeper.stateNonce();
            let actions = [ChangeType.SET_ADD_OPERATOR_NOW];
            // bool to bytes32 basically...
            let args = [Buffer.from("1".repeat(64), "hex")];
            res = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId, {from: operatorA.address});
            assert.equal(res.logs[0].event, "ConfigPending");
            await expect(
                applyDelayed({res}, operatorA, gatekeeper)
            ).to.be.revertedWith("apply called before due time");
            await utils.increaseTime(timeGap, web3);
            applyDelayed({res}, operatorA, gatekeeper);
            assert.equal(true, await gatekeeper.allowAddOperatorNow());
            stateId = await gatekeeper.stateNonce();
            res = await gatekeeper.addOperatorNow(operatorA.permLevel, operatorB.address, stateId, {from: operatorA.address});
            await cancelDelayed({res}, watchdogA, gatekeeper);

        });

        it("should revert an attempt to add an operator immediately by anyone other than operator", async function () {
            let stateId = await gatekeeper.stateNonce();
            await expect(
                gatekeeper.addOperatorNow(adminA.permLevel, operatorB.address, stateId, {from: adminA.address})
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanAddOperatorNow}`)
        });

    });

    describe("testing approval mechanism", function () {
        let failCloseGK;
        let res;

        before(async function () {

            failCloseGK = await Gatekeeper.new(zeroAddress, zeroAddress, accounts[0], {gas: 8e6});
        });

        it("should initialize gk with failclose levels", async function () {
            initialDelays = Array.from({length: 10}, (x, i) => (i + 1) * dayInSec);
            requiredApprovalsPerLevel = [1, 1, 1, 2, 3, 2, 5, 6, 7, 8];
            initialParticipants.push(utils.bufferToHex(utils.participantHash(operatorZ.address, operatorZ.permLevel)));

            res = await failCloseGK.initialConfig(initialParticipants, initialDelays, true, true, requiredApprovalsPerLevel, [], [], [], {from: operatorA.address});
            let log = res.logs[0];
            assert.equal(log.event, "GatekeeperInitialized");
        });

        it("should not approve non-exsiting change", async function () {
            let stateId = await failCloseGK.stateNonce();
            let changeType1 = ChangeType.ADD_PARTICIPANT;
            let changeArg1 = utils.participantHash(adminB1.address, adminB1.permLevel);

            await expect(
                failCloseGK.approveConfig(watchdogA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0, {from: watchdogA.address})
            ).to.be.revertedWith("approve called for non existent pending change");

        });

        it("should schedule and approve operation that requires one approval", async function () {
            let stateId = await failCloseGK.stateNonce();
            let changeType1 = ChangeType.ADD_PARTICIPANT;
            let changeArg1 = utils.participantHash(adminB1.address, adminB1.permLevel);
            await failCloseGK.changeConfiguration(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId);

            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("called before due time");

            await utils.increaseTime(timeGap, web3);

            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("Pending approvals");

            await expect(
                failCloseGK.approveConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanApprove}`);

            await failCloseGK.approveConfig(watchdogA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0, {from: watchdogA.address})
            await failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorA.address, operatorA.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("apply called for non existent pending change");

        });

        it("should schedule and approve operation that requires two approvals", async function () {
            let stateId = await failCloseGK.stateNonce();
            let changeType1 = ChangeType.ADD_PARTICIPANT;
            let changeArg1 = utils.participantHash(adminB1.address, adminB1.permLevel);
            res = await failCloseGK.changeConfiguration(operatorZ.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, {from: operatorZ.address});

            let txhash = await utilities.transactionHashPublic([changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0);

            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("called before due time");

            await utils.increaseTime(5 * timeGap, web3);

            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("Pending approvals");

            await expect(
                failCloseGK.approveConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0)
            ).to.be.revertedWith(`permissions missing: ${Permissions.CanApprove}`);

            await expect(
                failCloseGK.approveConfig(watchdogA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0, {from: watchdogA.address})
            ).to.be.revertedWith(`cannot approve operation from higher level`);

            await failCloseGK.approveConfig(watchdogZ.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0, {from: watchdogZ.address})
            assert.equal((await failCloseGK.getPendingChange(txhash)).approvers.length, 1)
            await expect(
                failCloseGK.approveConfig(watchdogZ.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0, {from: watchdogZ.address})
            ).to.be.revertedWith(`Cannot approve twice`);

            await expect(
                failCloseGK.applyConfig(operatorA.permLevel, [changeType1], [changeArg1], [changeArg1], stateId, operatorZ.address, operatorZ.permLevel, zeroAddress, 0)
            ).to.be.revertedWith("Pending approvals");

            await expect(
                cancelDelayed({res}, watchdogA, failCloseGK)
            ).to.be.revertedWith("cannot cancel, scheduler is of higher level");
            await cancelDelayed({res}, watchdogZ, failCloseGK)
        });

    });

    /* Owner finds the phone after losing it */
    it("should allow the owner to cancel an owner change");

    /* Owner finds the phone after losing it */
    it("should allow the admin to cancel an owner change");

    /* doomsday recover: all participants malicious */
    it("should allow the super-admin to lock out all participants, cancel all operations and replace all participants");

    /* Negative flows */

    /* Owner’s phone controlled by a malicious operator */
    it("should not allow the owner to cancel an owner change if an admin locks him out");

    it(`should allow the cancellers to cancel a delayed transfer transaction`, async function () {
        await utils.asyncForEach(
            [operatorA, watchdogA],
            async (participant) => {
                let stateId = await gatekeeper.stateNonce()
                let res1 = await gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, [], stateId);
                expectedDelayedEventsCount++;
                let log1 = res1.logs[0];

                let res2 = await gatekeeper.cancelBypassCall(
                    participant.permLevel,
                    log1.args.sender,
                    log1.args.senderPermsLevel,
                    log1.args.stateId,
                    log1.args.target,
                    log1.args.value,
                    [],
                    {from: participant.address});
                let log2 = res2.logs[0];
                assert.equal(log2.event, "BypassCallCancelled");
                assert.equal(log2.address, log1.address);
            });
    });

    function getNonSpenders() {
        return [
            adminA.expectError(`permissions missing: ${Permissions.CanSpend}`),
            watchdogA.expectError(`permissions missing: ${Permissions.CanSpend}`),
            wrongaddr.expectError("not participant")
        ];
    }

    function getNonChowners() {
        return [
            watchdogA.expectError(`permissions missing: ${Permissions.CanChangeOwner}`),
            wrongaddr.expectError("not participant")
        ];
    }

    function getNonConfigChangers() {
        return [
            adminA.expectError(`permissions missing: ${Permissions.CanChangeParticipants + Permissions.CanUnfreeze +
            Permissions.CanChangeBypass + Permissions.CanSetAcceleratedCalls + Permissions.CanSetAddOperatorNow + Permissions.CanAddOperatorNow}`),
            watchdogA.expectError(`permissions missing: ${Permissions.CanChangeConfig}`),
            wrongaddr.expectError("not participant")
        ];
    }

    function getNonBoostees() {
        return [
            adminA.expectError(`permissions missing: ${Permissions.CanSignBoosts + Permissions.CanUnfreeze +
            Permissions.CanChangeParticipants + Permissions.CanChangeBypass + Permissions.CanSetAcceleratedCalls
            + Permissions.CanSetAddOperatorNow + Permissions.CanAddOperatorNow}`),
            watchdogA.expectError(`permissions missing: ${Permissions.CanSignBoosts + Permissions.CanChangeConfig}`),
            wrongaddr.expectError("not participant")
        ];
    }

    // it(`should not allow non-chowners to change owner`, async function () {
    //     let stateId = await gatekeeper.stateNonce();
    //     await utils.asyncForEach(getNonChowners(), async (participant) => {
    //         await expect(
    //             gatekeeper.scheduleChangeOwner(participant.permLevel, adminC.address, stateId, {from: participant.address})
    //         ).to.be.revertedWith(participant.expectError);
    //         console.log(`${participant.name} + scheduleChangeOwner + ${participant.expectError}`)
    //     });
    // });

    /* Admin replaced - opposite  & Owner loses phone - opposite */
    it(`should not allow non-config-changers to add or remove admins or watchdogs`, async function () {
        let stateId = await gatekeeper.stateNonce();
        await utils.asyncForEach(getNonConfigChangers(), async (participant) => {
            let actions = [ChangeType.ADD_PARTICIPANT];
            let args = [utils.participantHash(adminC.address, adminC.permLevel)];
            await expect(
                gatekeeper.changeConfiguration(participant.permLevel, actions, args, args, stateId, {from: participant.address})
            ).to.be.revertedWith(participant.expectError);
            console.log(`${participant.name} + addParticipant + ${participant.expectError}`);

            actions = [ChangeType.REMOVE_PARTICIPANT];
            args = [utils.participantHash(adminA.address, adminA.permLevel)];
            await expect(
                gatekeeper.changeConfiguration(participant.permLevel, actions, args, args, stateId, {from: participant.address})
            ).to.be.revertedWith(participant.expectError);
            console.log(`${participant.name} + removeParticipant + ${participant.expectError}`)

        });
    });

    it.skip(`should not allow non-spenders to create a delayed transfer transaction`, async function () {
        let stateId = await gatekeeper.stateNonce();
        await utils.asyncForEach(getNonSpenders(), async (participant) => {
            await expect(
                gatekeeper.sendEther(destinationAddress, amount, participant.permLevel, initialDelays[1], stateId, {from: participant.address})
            ).to.be.revertedWith(participant.expectError);
            console.log(`${participant.name} + sendEther + ${participant.expectError}`)

        });
    });

    it.skip(`should not allow non-spenders to create a delayed ERC20 transfer transaction`, async function () {
        let stateId = await gatekeeper.stateNonce();
        await utils.asyncForEach(getNonSpenders(), async (participant) => {
            await expect(
                gatekeeper.sendERC20(destinationAddress, amount, participant.permLevel, initialDelays[1], erc20.address, stateId, {from: participant.address})
            ).to.be.revertedWith(participant.expectError);
            console.log(`${participant.name} + sendERC20 + ${participant.expectError}`)

        });
    });

    it.skip("should not allow \${${participant.title}} to freeze", async function () {

    });

    it("should not allow to freeze level that is higher than the caller's");
    it("should not allow to freeze for zero time");
    it("should not allow to freeze for enormously long time");

    // TODO: separate into 'isFrozen' check and a separate tests for each disabled action while frozen
    it("should allow the watchdog to freeze all participants below its level", async function () {
        let stateId = await gatekeeper.stateNonce();
        let res0;
        {
            let actions = [ChangeType.ADD_PARTICIPANT];
            let args = [utils.participantHash(watchdogB.address, watchdogB.permLevel)];
            res0 = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);
            await utils.increaseTime(timeGap, web3);
            await applyDelayed({res: res0}, operatorA, gatekeeper);
        }

        await utils.validateConfigParticipants([
            operatorA.expect(),
            watchdogA.expect(),
            watchdogB.expect(),
            adminA.expect(),
            adminB1.expect()
        ], gatekeeper);

        // set interval longer then delay, so that increase time doesn't unfreeze the vault
        let interval = timeGap * 2;
        let res = await gatekeeper.freeze(watchdogB.permLevel, level, interval, {from: watchdogB.address});
        let block = await web3.eth.getBlock(res.receipt.blockNumber);
        let log = res.logs[0];
        assert.equal(log.event, "LevelFrozen");
        assert.equal(log.args.frozenLevel, level);
        assert.equal(log.args.frozenUntil.toNumber(), block.timestamp + interval);
        assert.equal(log.args.sender, watchdogB.address);

        // Operator cannot send money any more
        let reason = "level is frozen";
        stateId = await gatekeeper.stateNonce();
        await expect(
            gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, [], stateId, {from: operatorA.address})
        ).to.be.revertedWith(reason);

        // On lower levels:
        // Operator cannot change configuration any more
        let actions = [ChangeType.ADD_PARTICIPANT];
        let args = [utils.participantHash(adminC.address, adminC.permLevel)];
        await expect(
            gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId),
            "addParticipant did not revert correctly"
            + ` with expected reason: "${reason}"`
        ).to.be.revertedWith(reason);

        // Admin cannot change owner any more
        // await expect(
        //     gatekeeper.scheduleChangeOwner(adminA.permLevel, adminC.address, stateId, {from: adminA.address}),
        //     "scheduleChangeOwner did not revert correctly"
        //     + ` with expected reason: "${reason}"`
        // ).to.be.revertedWith(reason);

        // Watchdog cannot cancel operations any more
        await expect(
            cancelDelayed({res: res0}, watchdogA, gatekeeper),
            "cancelOperation did not revert correctly"
            + ` with expected reason: "${reason}"`
        ).to.be.revertedWith(reason);

        await expect(
            gatekeeper.cancelBypassCall(watchdogA.permLevel, operatorA.address, operatorA.permLevel, 0, zeroAddress, 0, [], {from: watchdogA.address}),
            "cancelTransfer did not revert correctly"
            + ` with expected reason: "${reason}"`
        ).to.be.revertedWith(reason);

        // On the level of the freezer or up:
        // Admin can still call 'change owner'
        // let res2 = await gatekeeper.scheduleChangeOwner(adminB2.permLevel, operatorB.address, stateId, {from: adminB2.address});

        // Watchdog can still cancel stuff
        // let res3 = await cancelDelayed({res: res2}, watchdogB, gatekeeper);
        // assert.equal(res3.logs[0].event, "ConfigCancelled");
    });

    it("should not allow to shorten the length of a freeze");
    it("should not allow to lower the level of the freeze");

    it("should not allow non-boosters to unfreeze", async function () {

        await utils.asyncForEach(getNonBoostees(), async (signingParty) => {

            let actions = [ChangeType.UNFREEZE];
            let args = ["0x0"];
            let stateId = await gatekeeper.stateNonce();
            let encodedHash = await utilities.changeHash(actions, args, args, stateId);//utils.getTransactionHash(ABI.solidityPack(["uint8[]", "bytes32[]", "uint256"], [actions, args, stateId]));
            let signature = await utils.signMessage(encodedHash, web3, {from: signingParty.address});
            await expect(
                gatekeeper.boostedConfigChange(
                    adminB1.permLevel,
                    actions,
                    args,
                    args,
                    stateId,
                    signingParty.permLevel,
                    signature,
                    {from: adminB1.address})
            ).to.be.revertedWith(signingParty.expectError);

            console.log(`${signingParty.name} + boostedConfigChange + ${signingParty.expectError}`)
        });
    });

    it("should allow owner and admin together to unfreeze", async function () {
        // Meke sure vault is still frozen
        let frozenLevel = await gatekeeper.frozenLevel();
        let frozenUntil = parseInt(await gatekeeper.frozenUntil()) * 1000;
        assert.equal(frozenLevel, operatorA.level);
        let oneHourMillis = 60 * 60 * 1000;
        assert.isAtLeast(frozenUntil, Date.now() + oneHourMillis);

        // Schedule a boosted unfreeze by a high level admin
        let actions = [ChangeType.UNFREEZE];
        let args = ["0x0"];
        let stateId = await gatekeeper.stateNonce();
        let encodedHash = await utilities.changeHash(actions, args, args, stateId);//utils.getTransactionHash(ABI.solidityPack(["uint8[]", "bytes32[]", "uint256"], [actions, args, stateId]));
        let signature = await utils.signMessage(encodedHash, web3, {from: operatorA.address});
        let res1 = await gatekeeper.boostedConfigChange(adminB1.permLevel, actions, args, args, stateId, operatorA.permLevel, signature, {from: adminB1.address});
        let log1 = res1.logs[0];

        assert.equal(log1.event, "ConfigPending");

        // Execute the scheduled unfreeze
        await utils.increaseTime(timeGap, web3);

        // Operator still cannot send money, not time-caused unfreeze
        stateId = await gatekeeper.stateNonce()
        await expect(
            gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, [], stateId, {from: operatorA.address})
        ).to.be.revertedWith("level is frozen");
        let res3 = await applyDelayed({log: log1}, adminB1, gatekeeper);
        let log3 = res3.logs[0];

        assert.equal(log3.event, "UnfreezeCompleted");
        stateId = await gatekeeper.stateNonce()
        let res2 = await gatekeeper.scheduleBypassCall(operatorA.permLevel, destinationAddress, amount, [], stateId, {from: operatorA.address});
        expectedDelayedEventsCount++;
        let log2 = res2.logs[0];
        assert.equal(log2.event, "BypassCallPending");
        assert.equal(log2.address, gatekeeper.address);

    });

    describe("when schedule happens before freeze", function () {

        it("should not allow to apply an already scheduled Delayed Op if the scheduler's rank is frozen", async function () {
            // Schedule a totally valid config change
            let actions = [ChangeType.ADD_PARTICIPANT];
            let args = [utils.participantHash(adminB1.address, adminB1.permLevel)];
            let stateId = await gatekeeper.stateNonce();
            let res1 = await gatekeeper.changeConfiguration(operatorA.permLevel, actions, args, args, stateId);

            // Freeze the scheduler's rank
            await gatekeeper.freeze(watchdogB.permLevel, level, timeGap, {from: watchdogB.address});

            // Sender cannot apply anything - he is frozen
            await expect(
                applyDelayed({res: res1}, operatorA, gatekeeper)
            ).to.be.revertedWith("level is frozen");

            // Somebody who can apply cannot apply either
            await expect(
                applyDelayed({res: res1}, adminB1, gatekeeper)
            ).to.be.revertedWith("scheduler level is frozen");
        });

        // TODO: actually call unfreeze, as the state is different. Actually, this is a bit of a problem. (extra state: outdated freeze). Is there a way to fix it?
        it("should not allow to apply an already scheduled boosted Delayed Op if the booster's rank is also frozen", async function () {
            // Schedule a boosted unfreeze by a high level admin

            let actions = [ChangeType.UNFREEZE];
            let args = ["0x0"];
            let stateId = await gatekeeper.stateNonce();
            let encodedHash = await utilities.changeHash(actions, args, args, stateId);//utils.getTransactionHash(ABI.solidityPack(["uint8[]", "bytes32[]", "uint256"], [actions, args, stateId]));
            let signature = await utils.signMessage(encodedHash, web3, {from: operatorA.address});
            let res1 = await gatekeeper.boostedConfigChange(
                adminB1.permLevel,
                actions,
                args,
                args,
                stateId,
                operatorA.permLevel,
                signature,
                {from: adminB1.address});
            let log1 = res1.logs[0];
            assert.equal(log1.event, "ConfigPending");


            // Increase freeze level to one above the old booster level
            await gatekeeper.freeze(watchdogZ.permLevel, highLevel, timeGap, {from: watchdogZ.address});

            // Admin with level 5 tries to apply the boosted operation
            await expect(
                applyDelayed({res: res1}, adminZ, gatekeeper)
            ).to.be.revertedWith("booster level is frozen");

        });
    });

    it("should automatically unfreeze after a time interval");

    it("should revert an attempt to unfreeze if vault is not frozen");

    it("should validate correctness of claimed senderPermissions");
    it("should validate correctness of claimed sender address");
    it("should not allow any operation to be called without a delay");
    it("should only allow delayed calls to whitelisted operations");

    it("should revert an attempt to apply an operation under some other participant's name", async function () {
        // Schedule config change by operator, and claim to be an admin when applying
        let stateId = await gatekeeper.stateNonce();
        let changeType = ChangeType.ADD_PARTICIPANT;
        let changeArgs = utils.participantHash(adminB1.address, adminB1.permLevel);

        await gatekeeper.changeConfiguration(operatorA.permLevel, [changeType], [changeArgs], [changeArgs], stateId);

        await utils.increaseTime(timeGap, web3);
        // adminA cannot apply it - will not find it by hash
        await expect(
            gatekeeper.applyConfig(adminA.permLevel, [changeType], [changeArgs], [changeArgs], stateId, adminA.address, adminA.permLevel, zeroAddress, 0, {from: adminA.address})
        ).to.be.revertedWith("apply called for non existent pending change");

    });

    it("should revert an attempt to apply a boosted operation under some other participant's name");

    it("should revert an attempt to apply a boosted operation claiming wrong permissions");
    it("should revert an attempt to apply an operation claiming wrong permissions");


    it("should revert an attempt to schedule a transaction if the target state nonce is incorrect", async function () {
        let stateId = await gatekeeper.stateNonce();
        let changeType = ChangeType.ADD_PARTICIPANT;
        let changeArgs = utils.participantHash(adminB1.address, adminB1.permLevel);

        await expect(
            gatekeeper.changeConfiguration(operatorA.permLevel, [changeType], [changeArgs], [changeArgs], stateId - 1)
        ).to.be.revertedWith("contract state changed since transaction was created")
    });


    it("should save the block number of the deployment transaction", async function () {
        // not much to check here - can't know the block number
        let deployedBlock = (await gatekeeper.deployedBlock()).toNumber();
        assert.isAbove(deployedBlock, 0);
    });

    after("write coverage report", async () => {
        await global.postCoverage()
    });
});