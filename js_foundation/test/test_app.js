const {assert, expect} = require('chai');
const fs = require('fs');

const Web3 = require('web3');
const TruffleContract = require("truffle-contract");

const safeChannelUtils = require("../../solidity/src/js/SafeChannelUtils");
const Participant = require("../../solidity/src/js/Participant");

const Interactor = require("../src/js/VaultContractInteractor.js");
const ParticipantAddedEvent = require("../src/js/events/ParticipantAddedEvent");
const ParticipantRemovedEvent = require("../src/js/events/ParticipantRemovedEvent");
const OwnerChangedEvent = require("../src/js/events/OwnerChangedEvent");
const GatekeeperInitializedEvent = require("../src/js/events/GatekeeperInitializedEvent");
const LevelFrozenEvent = require("../src/js/events/LevelFrozenEvent");

const TransactionReceipt = require("../src/js/TransactionReceipt");
const ConfigurationDelta = require("../src/js/ConfigurationDelta");
const PermissionsModel = require("../src/js/PermissionsModel");

context('VaultContractInteractor Integration Test', function () {
    let ethNodeUrl = 'http://localhost:8545';
    let vaultFactoryAddress;
    let web3;
    let accounts;
    let interactor;

    let account23 = "0xcdc1e53bdc74bbf5b5f715d6327dca5785e228b4";

    let expectedUnfreezeOperation = "0x" +
        "0000000000000000000000000000000000000000000000000000000000000044" + // length
        "34cef0f1" + // keccak("unfreeze...")
        "00000000000000000000000090f8bf6a479f320ead074411a4b0e7944ea8c9c1" + // sender
        "0000000000000000000000000000000000000000000000000000000000000d3f";  // permLevel

    let expectedUnfreezeSignature = "0x" +
        "9ff890ec63d0b07099892bda49d21e59797204b8ddafd9c03f79f3df68069eef" + // R
        "2698fa61dae5644ab6f9a2af59da9f9447d7c41c35ca9633db0bf2b0ad0ed872" + // S
        "1c"; // V


    let operator;
    let admin23 = new Participant(account23, PermissionsModel.getAdminPermissions(), 1, "admin23");
    let admin_level2_acc2;

    before(async function () {
        let provider = new Web3.providers.HttpProvider(ethNodeUrl);
        web3 = new Web3(provider);
        accounts = await web3.eth.getAccounts();
        operator = new Participant(accounts[0], PermissionsModel.getOwnerPermissions(), 1, "operator");
        admin_level2_acc2 = new Participant(accounts[2], PermissionsModel.getAdminPermissions(), 2, "admin_level2_acc2");
        let vaultFactoryABI = require('../src/js/generated/VaultFactory');
        let vaultFactoryBin = fs.readFileSync("./src/js/generated/VaultFactory.bin");
        let vaultFactoryContract = TruffleContract({
            contractName: "VaultFactory",
            abi: vaultFactoryABI,
            binary: vaultFactoryBin,
            address: vaultFactoryAddress
        });
        vaultFactoryContract.setProvider(provider);
        let vaultFactory = await vaultFactoryContract.new({from: accounts[0]});
        vaultFactoryAddress = vaultFactory.address;
        interactor = await Interactor.connect(
            accounts[0],
            PermissionsModel.getOwnerPermissions(),
            1,
            ethNodeUrl,
            undefined,
            undefined,
            vaultFactoryAddress);
    });

    // write tests are quite boring as each should be just a wrapper around a Web3 operation, which
    // is tested in 'solidity' project to do what it says correctly

    context("creation of new vault", function () {
        it("deploys a new vault, but only if not initialized", async function () {
            let addressBefore = interactor.getGatekeeperAddress();
            assert.strictEqual(addressBefore, null);

            assert.notExists(interactor.vault);
            assert.notExists(interactor.gatekeeper);
            await interactor.deployNewGatekeeper();
            assert.exists(interactor.vault);
            assert.exists(interactor.gatekeeper);

            try {
                await interactor.deployNewGatekeeper();
                return Promise.reject(new Error('Should have thrown'));
            } catch (err) {
                expect(err).to.have.property('message', 'vault already deployed');
            }
        });

        it("the newly deployed vault should handle having no configuration", async function () {
            let operator = await interactor.getOperator();
            assert.equal(operator, null);
            let delays = await interactor.getDelays();
            assert.equal(delays.length, 0);
            let initializedEvent = await interactor.getGatekeeperInitializedEvent();
            assert.equal(initializedEvent, null);
            let addedEvents = await interactor.getParticipantAddedEvents();
            assert.equal(addedEvents.length, 0);
            let removedEvents = await interactor.getParticipantRemovedEvents();
            assert.equal(removedEvents.length, 0);
            let ownerEvents = await interactor.getOwnerChangedEvents();
            assert.equal(ownerEvents.length, 0);
            let freezeParams = await interactor.getFreezeParameters();
            assert.deepEqual(freezeParams, {frozenLevel: 0, frozenUntil: 0});
            let scheduledOperations = await interactor.getScheduledOperations();
            assert.equal(scheduledOperations.length, 0);
        });

        it("the newly deployed vault should accept the initial configuration", async function () {
            let anyAdmin = "0x" + safeChannelUtils.participantHash(account23, safeChannelUtils.packPermissionLevel(PermissionsModel.getAdminPermissions(), 1)).toString('hex');
            let participantsHashes = [
                anyAdmin,
                "0xbb",
                "0xcc",
            ];
            let delaysExpected = [1, 2, 3];
            await interactor.initialConfig({
                participants:
                participantsHashes,
                delays:
                delaysExpected
            });

            let initEvent = await interactor.getGatekeeperInitializedEvent();
            let expectedHashes = participantsHashes.map(function (hash) {
                return hash.padEnd(66, '0')
            });
            assert.deepEqual(initEvent.participantsHashes, expectedHashes);

            let operator = await interactor.getOperator();
            assert.equal(operator, accounts[0]);

            let delays = await interactor.getDelays();
            assert.deepEqual(delays, delaysExpected);

        });

    });

    context("using initialized and configured vault", function () {

        before(function () {
            // TODO: fund the vault
        });

        it("can schedule to change participants in the vault and later apply it", async function () {
            let participants = [
                operator.expect(),
                admin23.expect(),
                admin_level2_acc2];
            await safeChannelUtils.validateConfig(participants, interactor.gatekeeper);

            let permLevelToRemove = safeChannelUtils.packPermissionLevel(PermissionsModel.getAdminPermissions(), 1);
            let change = new ConfigurationDelta([
                    {
                        address: admin_level2_acc2.address,
                        permissions: admin_level2_acc2.permissions,
                        level: admin_level2_acc2.level
                    }
                ],
                [
                    {hash: safeChannelUtils.participantHash(account23, permLevelToRemove)}
                ]);
            let receipt1 = await interactor.changeConfiguration(change);
            let blockOptions = {
                fromBlock: receipt1.blockNumber,
                toBlock: receipt1.blockNumber
            };
            // values here are not deterministic. I can only check they exist.
            assert.equal(receipt1.blockHash.length, 66);
            assert.equal(receipt1.transactionHash.length, 66);
            assert.isAbove(receipt1.blockNumber, 0);
            assert.isAbove(receipt1.gasUsed, 21000);

            let delayedOpEvents = await interactor.getDelayedOperationsEvents(blockOptions);
            assert.equal(delayedOpEvents.length, 1);

            let delays = await interactor.getDelays();
            let time = delays[1] + 100;
            // TODO: fix when delay per level is implemented
            await safeChannelUtils.increaseTime(1000 * 60 * 60 * 24, web3);

            let receipt2 = await interactor.applyBatch(delayedOpEvents[0].operation, delayedOpEvents[0].opsNonce);
            blockOptions = {
                fromBlock: receipt2.blockNumber,
                toBlock: receipt2.blockNumber
            };
            let addedEvents = await interactor.getParticipantAddedEvents(blockOptions);
            assert.equal(addedEvents.length, 1);
            participants = [
                operator.expect(),
                admin23,
                admin_level2_acc2.expect()];
            await safeChannelUtils.validateConfig(participants, interactor.gatekeeper);

        });

        it("can freeze and unfreeze", async function () {
            let receipt1 = await interactor.freeze(1, 1000);
            let levelFrozenEvents = await interactor.getLevelFrozenEvents(
                {
                    fromBlock: receipt1.blockNumber,
                    toBlock: receipt1.blockNumber
                });
            assert.equal(levelFrozenEvents.length, 1);

            let freezeParameters = await interactor.getFreezeParameters();


            let block = await web3.eth.getBlock(receipt1.blockNumber);
            let expectedFrozenUntil = block.timestamp + 1000;

            // check that event and contract state are correct and consistent
            assert.equal(levelFrozenEvents[0].frozenLevel, 1);
            assert.equal(levelFrozenEvents[0].frozenUntil, expectedFrozenUntil);
            assert.equal(freezeParameters.frozenLevel, 1);
            assert.equal(freezeParameters.frozenUntil, expectedFrozenUntil);

            let signedRequest = await interactor.signBoostedConfigChange({unfreeze: true});
            assert.equal(signedRequest.operation, expectedUnfreezeOperation);
            assert.equal(signedRequest.signature, expectedUnfreezeSignature);

            // To unfreeze, need to create a different 'interactor' - used by the admin of a higher level
            let adminsInteractor = await Interactor.connect(
                admin_level2_acc2.address,
                admin_level2_acc2.permissions,
                admin_level2_acc2.level,
                ethNodeUrl,
                interactor.gatekeeper.address,
                interactor.vault.address,
                vaultFactoryAddress
            );
            let receipt2 = await adminsInteractor.scheduleBoostedConfigChange({
                operation: signedRequest.operation,
                signature: signedRequest.signature,
                signerPermsLevel: operator.permLevel
            });

            let delayedOpEvents = await interactor.getDelayedOperationsEvents({
                fromBlock: receipt2.blockNumber,
                toBlock: receipt2.blockNumber
            });
            assert.equal(delayedOpEvents.length, 1);
            // TODO: fix when delay per level is implemented
            await safeChannelUtils.increaseTime(1000 * 60 * 60 * 24, web3);
            let receipt3 = await interactor.applyBatch(delayedOpEvents[0].operation, delayedOpEvents[0].opsNonce, admin_level2_acc2);

            let unfreezeCompleteEvents = await interactor.getUnfreezeCompletedEvents(
                {
                    fromBlock: receipt3.blockNumber,
                    toBlock: receipt3.blockNumber
                });

            assert.equal(unfreezeCompleteEvents.length, 1);

            let freezeParameters2 = await interactor.getFreezeParameters();
            assert.deepEqual(freezeParameters2, {frozenLevel: 0, frozenUntil: 0});
        });

        it.skip("can change owner", async function () {
            assert.fail()
        });

        it.skip("can transfer different types of assets", async function () {
            assert.fail()
        });


        // ****** read tests

        context.skip("reading directly from the contract's state", function () {
            it("read operator", async function () {
                assert.fail()
            });
            it("read balances", async function () {
                assert.fail()
            });
        });


        context.skip("reading by parsing the event logs", function () {
            it("read participant hashes", async function () {
                assert.fail()
            });
        });
    });
});