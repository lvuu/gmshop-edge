export interface DeliveryQueueMessage {
	kind: "commerce.delivery";
	version: 1;
	deliveryId: string;
}

export interface AutomationQueueMessage {
	kind: "commerce.automation";
	version: 1;
	automationJobId: string;
}

export interface NotificationQueueMessage {
	kind: "commerce.notification";
	version: 1;
	notificationDeliveryId: string;
}

export interface RefundQueueMessage {
	kind: "commerce.refund";
	version: 1;
	refundId: string;
}

export interface SupplierQueueMessage {
	kind: "commerce.supplier";
	version: 1;
	supplierOrderId: string;
}

export interface MaintenanceQueueMessage {
	kind: "commerce.maintenance";
	version: 1;
	scheduledAt: number;
}

export type CommerceQueueMessage =
	| DeliveryQueueMessage
	| AutomationQueueMessage
	| NotificationQueueMessage
	| RefundQueueMessage
	| SupplierQueueMessage
	| MaintenanceQueueMessage;
