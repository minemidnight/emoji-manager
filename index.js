global.Promise = require("bluebird");
const superagent = require("superagent");
const Eris = require("eris-additions")(require("eris"), {
	enabled: [
		"Channel.awaitMessages",
		"Member.bannable",
		"Member.kickable",
		"Member.punishable",
		"Role.addable"
	]
});

if(!process.env.TOKEN || !process.env.USER_TOKEN) {
	console.error("Both TOKEN and USER_TOKEN must be set as environment variables");
	process.exit(0);
}

const bot = new Eris(process.env.TOKEN, {
	disableEvents: {
		PRESENCE_UPDATE: true,
		TYPING_START: true,
		USER_UPDATE: true,
		VOICE_STATE_UPDATE: true
	},
	messageLimit: 0,
	defaultImageFormat: "png",
	defaultImageSize: 256
});

const userbot = new Eris(process.env.USER_TOKEN);

bot.once("ready", () => {
	console.log("Bot Started");
	bot.editStatus("online", { name: "with emojis" });
});

bot.connect();

const data = guild => {
	const dataChannel = guild.channels.find(channel => channel.name === "bot-data");
	const settings = Object.assign({ data: dataChannel.id }, JSON.parse(dataChannel.topic));

	return {
		field(field) {
			return settings[field];
		},
		async add(json) {
			const { content } = await bot.createMessage(settings.data, JSON.stringify(json));

			return JSON.parse(content);
		},
		async update(id, json) {
			const msgs = await bot.getMessages(settings.data, 100);
			const toEdit = msgs.find(msg => JSON.parse(msg.content).id === id);

			const { content } = await toEdit.edit(JSON.stringify(json));
			return JSON.parse(content);
		},
		async get(idSearch) {
			const msgs = await bot.getMessages(settings.data, 100);
			return msgs.map(msg => JSON.parse(msg.content)).find(({ id }) => id === idSearch);
		},
		async delete(id) {
			const msgs = await bot.getMessages(settings.data, 100);
			return await Promise.all(
				msgs.filter(msg => JSON.parse(msg.content).id === id)
					.map(msg => msg.delete())
			);
		}
	};
};

bot.on("messageCreate", async message => {
	if(!message.channel.guild || !message.channel.guild) return;
	else if(message.author.id === bot.user.id) return;

	const dataController = data(message.channel.guild);
	if(message.channel.id === dataController.field("suggest")) {
		const [attach] = message.attachments;
		const name = attach.filename.substring(0, attach.filename.lastIndexOf("."));

		if(!attach || !attach.height || !attach.width || !(/^[A-Z0-9_]{2,32}$/i).test(name)) {
			await message.delete();
			return;
		}

		const { headers: { "content-type": contentType }, body: image } = await superagent.get(attach.url);
		const emoji = await userbot.createGuildEmoji(message.channel.guild.id, {
			name,
			image: `data:${contentType};base64,${image.toString("base64")}`
		});

		const msg = await message.channel.createMessage("**EMOJI SUGGESTION**\n" +
			`Creator: ${message.author.mention}\n` +
			`<:${emoji.name}:${emoji.id}>`);

		await message.delete();
		await dataController.add({
			id: msg.id,
			emojiID: emoji.id,
			name: emoji.name,
			user: message.author.id,
			type: "approval"
		});
	} else if(message.channel.id === dataController.field("vote")) {
		await message.delete();
		const emoji = message.content.match(/<:[A-Z0-9_]{2,32}:(\d{14,20})>/i);
		if(!emoji) return;

		const msg = await message.channel.createMessage(emoji[0]);
		await msg.addReaction("✅");
		await msg.addReaction("❌");
		await dataController.add({
			id: msg.id,
			emojiID: emoji[1],
			type: "vote",
			manual: true
		});
	}
});

bot.on("messageReactionAdd", async (message, emoji, userID) => {
	message = await bot.getMessage(message.channel.id, message.id);
	const dataController = data(message.channel.guild);

	const isAdmin = ~message.channel.guild.members.get(userID).roles.indexOf(dataController.field("admin"));
	if(message.channel.id === dataController.field("suggest") && isAdmin) {
		const { name, emojiID, user } = await dataController.get(message.id);
		await dataController.delete(message.id);
		await bot.deleteMessage(message.channel.id, message.id);

		if(emoji.name === "✅") {
			const msg = await bot.createMessage(dataController.field("vote"), `<:${name}:${emojiID}>`);
			await msg.addReaction("✅");
			await msg.addReaction("❌");
			await dataController.add({
				id: msg.id,
				emojiID,
				name,
				type: "vote",
				user
			});
		} else if(emoji.name === "❌") {
			await bot.createMessage(dataController.field("changes"),
				`Denied <:${name}:${emojiID}> (during approval)`);

			await userbot.deleteGuildEmoji(message.channel.guild.id, emojiID);
		} else {
			message.removeReaction(emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name, userID);
		}
	} else if(message.channel.id === dataController.field("vote")) {
		if(emoji.name === "✅") {
			if(!isAdmin) return;
			const { emojiID, manual, name, user } = await dataController.get(message.id);
			await dataController.delete(message.id);
			await bot.deleteMessage(message.channel.id, message.id);

			if(manual) await bot.createMessage(dataController.field("changes"), `Kept <:${name}:${emojiID}> as an emote`);
			else await bot.createMessage(dataController.field("changes"), `Accepted <:${name}:${emojiID}>`);
			if(user) bot.addGuildMemberRole(message.channel.guild.id, user, dataController.field("artist"));
		} else if(emoji.name === "❌") {
			if(!isAdmin) return;
			const { emojiID, manual, name } = await dataController.get(message.id);
			await dataController.delete(message.id);
			await bot.deleteMessage(message.channel.id, message.id);

			if(manual) await bot.createMessage(dataController.field("changes"), `Deleted <:${name}:${emojiID}> after a vote`);
			else await bot.createMessage(dataController.field("changes"), `Denied <:${name}:${emojiID}> (during vote)`);
			await userbot.deleteGuildEmoji(message.channel.guild.id, emojiID);
		} else {
			await bot.removeMessageReaction(message.channel.id,
				message.id,
				emoji.id ? `${emoji.name}:${emoji.id}` : emoji.name,
				userID);
		}
	}
});
