import case_ from "case";
import emojiRegex from "emoji-regex";
import isUrl from "is-url-superb";
import { toString } from "mdast-util-to-string";
import { lintRule } from "unified-lint-rule";
import { find } from "unist-util-find";
import { findAllAfter } from "unist-util-find-all-after";
import { visit } from "unist-util-visit";
import identifierAllowList from "../lib/identifier-allow-list.js";

const { of: caseOf } = case_;

// Valid casings for first text word in list item descriptions
const listItemPrefixCaseAllowList = new Set([
	"camel",
	"capital",
	"constant",
	"pascal",
	"upper",
]);

// Valid node types in list item link
const listItemLinkNodeAllowList = new Set(["emphasis", "inlineCode", "text"]);

// Valid node types in list item descriptions
const listItemDescriptionNodeAllowList = new Set([
	"emphasis",
	"footnoteReference",
	"html",
	"image",
	"inlineCode",
	"link",
	"linkReference",
	"strong",
	"text",
]);

// Valid node types in list item description suffix
const listItemDescriptionSuffixNodeAllowList = new Set([
	"emphasis",
	"html",
	"image",
	"link",
	"strong",
	"text",
]);

const listItemRule = lintRule("remark-lint:awesome-list-item", (ast, file) => {
	let lists = findAllLists(ast);

	const toc = find(
		ast,
		(node) =>
			node.type === "heading" &&
			node.depth === 2 &&
			toString(node)
				.replaceAll(/<!--.*?-->/g, "")
				.trim() === "Contents",
	);

	if (toc) {
		const postContentsHeading = findAllAfter(ast, toc, {
			type: "heading",
		})[0];

		if (!postContentsHeading) {
			return;
		}

		lists = extractSublists(
			findAllAfter(ast, postContentsHeading, { type: "list" }),
		);
	}

	for (const list of lists) {
		validateList(list, file);
	}
});

function findAllLists(ast) {
	const lists = [];
	visit(ast, "list", (list) => {
		lists.push(list);
	});
	return lists;
}

function extractSublists(lists) {
	let allLists = [];

	for (const list of lists) {
		allLists = [...allLists, ...findAllLists(list)];
	}

	return allLists;
}

function validateList(list, file) {
	for (const listItem of list.children) {
		const [paragraph] = listItem.children;

		if (
			!paragraph ||
			paragraph.type !== "paragraph" ||
			paragraph.children.length === 0
		) {
			file.message("Invalid list item", paragraph);
			continue;
		}

		if (paragraph.children[0].type === "text") {
			continue;
		}

		let [link, ...description] = paragraph.children;

		// Might have children like: '{image} {text} {link} { - description}'
		// Keep discarding prefix elements until we find something link-like.
		while (
			link.type !== "linkReference" &&
			link.type !== "link" &&
			description.length > 1
		) {
			link = description[0];
			description = description.slice(1);
		}

		if (!validateListItemLink(link, file)) {
			continue;
		}

		if (!validateListItemLinkChildren(link, file)) {
			continue;
		}

		validateListItemDescription(description, file);
	}
}

function validateListItemLinkChildren(link, file) {
	for (const node of link.children) {
		if (!listItemLinkNodeAllowList.has(node.type)) {
			file.message("Invalid list item link", node);
			return false;
		}
	}

	return true;
}

function validateListItemLink(link, file) {
	// NB. We need remark-lint-no-undefined-references separately
	// to catch if this is a valid reference. Here we only care that it exists.
	if (link.type === "linkReference") {
		return true;
	}

	if (link.type !== "link") {
		file.message("Invalid list item link", link);
		return false;
	}

	if (!isUrl(link.url)) {
		file.message("Invalid list item link URL", link);
		return false;
	}

	const linkText = toString(link);
	if (!linkText) {
		file.message("Invalid list item link text", link);
		return false;
	}

	return true;
}

function validateListItemDescription(description, file) {
	if (description.length === 0) {
		return;
	}

	const descriptionText = toString({ type: "root", children: description });
	// Check for special-cases with simple descriptions
	if (validateListItemSpecialCases(description, descriptionText)) {
		return true;
	}

	const dash = description[0];
	const dashText = toString(dash);

	// Ensure description starts with a dash separator or an acceptable special-case
	if (
		dash.type !== "text" ||
		!validateListItemPrefix(descriptionText, dashText)
	) {
		if (/^[\s\u00A0]-[\s\u00A0]/.test(dashText)) {
			file.message(
				"List item link and description separated by invalid whitespace",
				dash,
			);
			return false;
		}

		// Some editors auto-correct ' - ' to – (en-dash). Also avoid — (em-dash).
		if (/^\s*[/\u{02013}\u{02014}]/u.test(dashText)) {
			file.message(
				"List item link and description separated by invalid en-dash or em-dash",
				dash,
			);
			return false;
		}

		file.message(
			"List item link and description must be separated with a dash",
			dash,
		);
		return false;
	}

	// Support trailing inlineCode badges after punctuation
	let lastNonBadgeIndex = description.length - 1;
	while (
		lastNonBadgeIndex >= 0 &&
		(description[lastNonBadgeIndex].type === "inlineCode" ||
			(description[lastNonBadgeIndex].type === "text" &&
				/^\s*$/.test(toString(description[lastNonBadgeIndex]))))
	) {
		lastNonBadgeIndex--;
	}

	// This would be something like this: [test](#) - `Beta` `Stale` which should not be allowed
	if (lastNonBadgeIndex < 0) {
		file.message(
			"List item description must not consist of only badges",
			description[0],
		);
		return false;
	}

	// This is the part of the description that is _before_ a badge (if any)
	const suffixWithoutBadge = description[lastNonBadgeIndex];
	const suffixWithoutBadgeText = toString(suffixWithoutBadge);

	// Ensure description ends with an acceptable node type (before badges)
	if (!listItemDescriptionSuffixNodeAllowList.has(suffixWithoutBadge.type)) {
		file.message(
			"List item description must end with proper punctuation",
			suffixWithoutBadge,
		);
		return false;
	}

	const hasBadges = lastNonBadgeIndex < description.length - 1;
	const beforeBadges = description.slice(0, lastNonBadgeIndex + 1);

	// Ensure description ends with '.', '!', '?', '…' or an acceptable special-case (before badges)
	if (suffixWithoutBadge.type === "text") {
		let lastSuffixText = toString({ type: "root", children: beforeBadges });

		if (hasBadges) {
			// If there are badges, it is fine that the lastSuffixText has spaces on the right side
			lastSuffixText = lastSuffixText.trimEnd();
		}

		if (!validateListItemSuffix(lastSuffixText, suffixWithoutBadgeText)) {
			file.message(
				"List item description must end with proper punctuation",
				suffixWithoutBadge,
			);
			return false;
		}
	}

	if (dash === suffixWithoutBadge) {
		// Description contains pure text
		if (!validateListItemPrefixCasing(dash, file)) {
			return false;
		}
	} else {
		// Description contains mixed node types
		for (const node of beforeBadges) {
			if (!listItemDescriptionNodeAllowList.has(node.type)) {
				file.message("List item description contains invalid markdown", node);
				return false;
			}
		}

		if (dash.length > 3 && !validateListItemPrefixCasing(dash, file)) {
			return false;
		}
	}

	return true;
}

function validateListItemSpecialCases(description, descriptionText) {
	if (descriptionText.startsWith(" - ")) {
		return false;
	}

	const text = descriptionText.replace(emojiRegex(), "").trim();

	if (!text) {
		// Description contains only emoji and spaces
		return true;
	}

	if (/^\s\([^)]+\)\s*$/.test(descriptionText)) {
		// Description contains only a parenthetical
		return true;
	}

	if (/^\([^)]+\)$/.test(text)) {
		// Description contains only a parenthetical and emojis
		return true;
	}

	return false;
}

function tokenizeWords(text) {
	return text.split(/[- ;./']/).filter(Boolean);
}

function validateListItemPrefixCasing(prefix, file) {
	const strippedPrefix = prefix.value.slice(3);
	const [firstWord] = tokenizeWords(strippedPrefix);

	if (!firstWord) {
		file.message(
			"List item description must start with a non-empty string",
			prefix,
		);
		return false;
	}

	if (
		!listItemPrefixCaseAllowList.has(
			caseOf(firstWord.replaceAll(/\W+/g, "")),
		) &&
		!/\d/.test(firstWord) &&
		!/^["“'(]/.test(firstWord) &&
		!identifierAllowList.has(firstWord)
	) {
		file.message("List item description must start with valid casing", prefix);
		return false;
	}

	return true;
}

function validateListItemPrefix(descriptionText, prefixText) {
	if (prefixText.startsWith(" - ")) {
		// Description starts with a dash
		return true;
	}

	if (textEndsWithEmoji(prefixText) && descriptionText === prefixText) {
		// Description ends with an emojii
		return true;
	}

	return false;
}

function validateListItemSuffix(descriptionText, suffixText) {
	// Punctuation rules are available at: https://www.thepunctuationguide.com

	// Descriptions are not allowed to be fully backticked quotes, whatever the
	// ending punctuation and its position.
	if (/^`.*[.!?…]*`[.!?…]*$/.test(descriptionText)) {
		// Still allow multiple backticks if the whole description is not fully
		// quoted.
		if (/^`.+`.+`.+$/.test(descriptionText)) {
			return true;
		}

		return false;
	}

	// Any kind of quote followed by one of our punctuaction marker is perfect,
	// but only if not following a punctuation itself. Uses positive lookbehind
	// to search for punctuation following a quote.
	if (/.*(?<=["”])[.!?…]+$/.test(descriptionText)) {
		// If the quote follows a regular punctuation, this is wrong.
		if (/.*[.!?…]["”][.!?…]+$/.test(descriptionText)) {
			return false;
		}

		return true;
	}

	// Any of our punctuation marker eventually closed by any kind of quote is
	// good.
	if (/.*[.!?…]["”]?$/.test(descriptionText)) {
		return true;
	}

	if (!/[.!?…]/.test(descriptionText)) {
		// Description contains no punctuation
		const tokens = tokenizeWords(descriptionText);
		if (tokens.length > 2 || !textEndsWithEmoji(tokens.at(-1))) {
			return false;
		}
	}

	if (/\)\s*$/.test(suffixText)) {
		// Description contains punctuation and ends with a parenthesis
		return true;
	}

	if (textEndsWithEmoji(suffixText)) {
		// Description contains punctuation and ends with an emoji
		return true;
	}

	return false;
}

function textEndsWithEmoji(text) {
	const regex = emojiRegex();
	let match;
	let emoji;
	let emojiIndex;

	// Find last emoji in text (if any exist)
	while ((match = regex.exec(text))) {
		const { index } = match;
		emoji = match[0];
		emojiIndex = index;
	}

	if (emoji && emoji.length + emojiIndex >= text.length) {
		return true;
	}

	return false;
}

export default listItemRule;
